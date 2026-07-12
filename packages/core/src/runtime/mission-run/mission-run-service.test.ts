import { MissionSchema, RunSchema } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import { openLocalLibsqlDb } from '../../db/local-libsql-db.js';
import { openMissionControlDb } from '../../db/mission-control-db.js';
import { localSessionDbPath, localSessionDbUrl } from '../../memory/local-session-store-paths.js';
import { TursoPersistentStore } from '../../memory/turso-persistent-store.js';
import { completeRun, failRun, materializeMission, startRun } from './mission-run-service.js';
import { normalizeMissionRunStoreLocation } from './mission-run-store-location.js';
import {
    makeCategorizedWorkflowSpec,
    makeTempRoot,
    makeTestWorkflowSpec,
    seedOmoRoot,
} from './mission-run-test-support.js';
import { createMission, listMissions, missionFilePath, readMission } from './mission-store.js';
import {
    createRun,
    findMostRecentFailedRun,
    listRunsForMission,
    MissionRunTransitionError,
    readRun,
    runFilePath,
    updateRunStatus,
} from './run-store.js';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

describe('materializeMission', () => {
    it('creates a valid draft Mission from a WorkflowSpec', () => {
        const spec = makeTestWorkflowSpec();

        const mission = materializeMission(spec);

        expect(mission.id).toHaveLength(36);
        expect(mission.name).toBe('test-workflow');
        expect(mission.description).toBe('A test workflow');
        expect(mission.status).toBe('draft');
        expect(mission.graph).toBeDefined();
        expect(mission.graph?.id).toBe('test-graph');
        expect(mission.workflowName).toBe('test-workflow');
        expect(mission.createdAt).toBeDefined();
        expect(mission.updatedAt).toBeDefined();
        expect(mission.capabilities).toEqual({ allow: [], deny: [] });
        expect(() => MissionSchema.parse(mission)).not.toThrow();
    });

    it('derives capabilities from categories and modeDeclarations from modes', () => {
        const spec = makeCategorizedWorkflowSpec();

        const mission = materializeMission(spec);

        expect(mission.capabilities.allow).toContain('read');
        expect(mission.capabilities.allow).toContain('edit');
        expect(mission.modeDeclarations).toEqual([{ modeId: 'autopilot', active: true }]);
    });

    it('generates unique ids on repeated calls', () => {
        const spec = makeTestWorkflowSpec();

        const mission1 = materializeMission(spec);
        const mission2 = materializeMission(spec);

        expect(mission1.id).not.toBe(mission2.id);
    });
});

describe('Mission/Run SQL location', () => {
    it('treats a string as the project root and resolves only the SQL data dir', () => {
        const tempRoot = makeTempRoot();
        const dataDir = join(tempRoot, 'environment-data');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);

        const location = normalizeMissionRunStoreLocation(join(tempRoot, 'project'));

        expect(location).toEqual({ omoRoot: join(tempRoot, 'project'), dataDir });
    });

    it('writes only to an explicit data dir when the project root is separate', async () => {
        const tempRoot = makeTempRoot();
        const omoRoot = join(tempRoot, 'workspace');
        const dataDir = join(tempRoot, 'product-data');
        const defaultDataDir = join(tempRoot, 'environment-data');
        mkdirSync(omoRoot, { recursive: true });
        seedOmoRoot(omoRoot);
        vi.stubEnv('MCTRL_DATA_DIR', defaultDataDir);
        const mission = materializeMission(makeTestWorkflowSpec());

        await createMission({ omoRoot, dataDir }, mission);

        expect(existsSync(localSessionDbPath(dataDir))).toBe(true);
        expect(existsSync(localSessionDbPath(defaultDataDir))).toBe(false);
        expect(existsSync(join(omoRoot, 'memory.db'))).toBe(false);
        expect(existsSync(join(omoRoot, '.omo', 'memory.db'))).toBe(false);
        expect(existsSync(localSessionDbPath(omoRoot))).toBe(false);
    });

    it('ignores a workspace-only legacy SQL database', async () => {
        const tempRoot = makeTempRoot();
        const omoRoot = join(tempRoot, 'workspace');
        const dataDir = join(tempRoot, 'product-data');
        mkdirSync(omoRoot, { recursive: true });
        seedOmoRoot(omoRoot);
        const legacyMission = materializeMission(makeTestWorkflowSpec());
        const legacyDb = await openLocalLibsqlDb({ url: pathToFileURL(join(omoRoot, 'memory.db')).href });
        await legacyDb.client.execute({
            sql:
                'INSERT INTO missions (mission_id, status, workflow_name, created_at, updated_at, payload_json) ' +
                'VALUES (?, ?, ?, ?, ?, ?)',
            args: [
                legacyMission.id,
                legacyMission.status,
                legacyMission.workflowName ?? null,
                legacyMission.createdAt,
                legacyMission.updatedAt,
                JSON.stringify(legacyMission),
            ],
        });
        legacyDb.close();

        const missions = await listMissions({ omoRoot, dataDir });

        expect(missions).toEqual([]);
        expect(existsSync(localSessionDbPath(dataDir))).toBe(true);
    });
});

describe('mission-run lifecycle', () => {
    it('transitions pending -> running -> completed with cost and terminal reason', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);

        const runningRun = await startRun(root, mission.id, 'do the thing');

        expect(runningRun.status).toBe('running');
        expect(runningRun.missionId).toBe(mission.id);
        expect(runningRun.sessionId).toBeDefined();
        expect(runningRun.startedAt).toBeDefined();
        expect((await readMission(root, mission.id)).status).toBe('active');

        const completedRun = await completeRun(root, runningRun.id, {
            cost: { cents: 150, inputTokens: 1000, outputTokens: 500, modelCalls: 3 },
            terminalReason: 'all steps done',
        });

        expect(completedRun.status).toBe('completed');
        expect(completedRun.cost.cents).toBe(150);
        expect(completedRun.cost.inputTokens).toBe(1000);
        expect(completedRun.cost.modelCalls).toBe(3);
        expect(completedRun.terminalReason).toBe('all steps done');
        expect(completedRun.endedAt).toBeDefined();
        expect(completedRun.startedAt).toBeDefined();
    });

    it('transitions running -> failed with terminal reason', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const runningRun = await startRun(root, mission.id, 'try and fail');

        const failedRun = await failRun(root, runningRun.id, 'provider timeout');

        expect(failedRun.status).toBe('failed');
        expect(failedRun.terminalReason).toBe('provider timeout');
        expect(failedRun.endedAt).toBeDefined();
    });

    it('persists the initiating prompt on the Run so /retry can recover it', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);

        const runningRun = await startRun(root, mission.id, 'fix the @-autocomplete bug');

        const reloaded = await readRun(root, runningRun.id);
        expect(reloaded.prompt).toBe('fix the @-autocomplete bug');
    });

    it('persists mission and run records in the shared local memory DB across reopen', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const runningRun = await startRun(root, mission.id, 'survive reopen');

        const completedRun = await completeRun(root, runningRun.id, { terminalReason: 'done after reopen' });
        const reloadedMission = await readMission(root, mission.id);
        const reloadedRun = await readRun(root, runningRun.id);
        const runs = await listRunsForMission(root, mission.id);
        const memoryStore = TursoPersistentStore.fromRuntime(await openMissionControlDb({ dataDir: root.dataDir }));
        await memoryStore.set('ship', 'goals', { status: 'shared-db' });
        memoryStore.close();
        const sharedDb = await openLocalLibsqlDb({ url: localSessionDbUrl(root.dataDir) });
        const memoryRows = await sharedDb.client.execute({
            sql: 'SELECT value FROM memory_entries WHERE namespace = ? AND key = ?',
            args: ['goals', 'ship'],
        });
        const missionRows = await sharedDb.client.execute({
            sql: 'SELECT mission_id FROM missions WHERE mission_id = ?',
            args: [mission.id],
        });
        const runRows = await sharedDb.client.execute({
            sql: 'SELECT run_id FROM mission_runs WHERE run_id = ?',
            args: [runningRun.id],
        });
        sharedDb.close();

        expect(existsSync(localSessionDbPath(root.dataDir))).toBe(true);
        expect(existsSync(join(root.omoRoot, '.omo', 'mission-control.db'))).toBe(false);
        expect(existsSync(missionFilePath(root.omoRoot, mission.id))).toBe(false);
        expect(existsSync(runFilePath(root.omoRoot, runningRun.id))).toBe(false);
        expect(memoryRows.rows).toEqual([{ value: '{"status":"shared-db"}' }]);
        expect(missionRows.rows).toEqual([{ mission_id: mission.id }]);
        expect(runRows.rows).toEqual([{ run_id: runningRun.id }]);
        expect(reloadedMission.status).toBe('active');
        expect(reloadedRun).toEqual(completedRun);
        expect(runs.map((run) => run.id)).toEqual([runningRun.id]);
        expect(runs[0]?.terminalReason).toBe('done after reopen');
    });

    it('findMostRecentFailedRun returns the latest failed run by endedAt', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);

        const first = await startRun(root, mission.id, 'first attempt');
        await failRun(root, first.id, 'boom');
        const second = await startRun(root, mission.id, 'second attempt');
        await failRun(root, second.id, 'boom again');

        const latest = await findMostRecentFailedRun(root);

        expect(latest).toBeDefined();
        expect(latest?.id).toBe(second.id);
        expect(latest?.prompt).toBe('second attempt');
    });

    it('findMostRecentFailedRun ignores completed runs and returns undefined when none failed', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);

        expect(await findMostRecentFailedRun(root)).toBeUndefined();
        const run = await startRun(root, mission.id, 'succeeds');
        await completeRun(root, run.id);

        expect(await findMostRecentFailedRun(root)).toBeUndefined();
    });

    it('throws MissionRunTransitionError on invalid transition from pending to completed', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const run = RunSchema.parse({
            id: crypto.randomUUID(),
            missionId: mission.id,
            status: 'pending' as const,
        });
        await createRun(root, run);

        await expect(updateRunStatus(root, run.id, 'completed')).rejects.toBeInstanceOf(MissionRunTransitionError);
    });

    it('throws MissionRunTransitionError when transitioning from a terminal state', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const runningRun = await startRun(root, mission.id, 'complete then try to resume');
        await completeRun(root, runningRun.id);

        await expect(updateRunStatus(root, runningRun.id, 'running')).rejects.toBeInstanceOf(MissionRunTransitionError);
    });

    it('supports blocked -> running transition', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const runningRun = await startRun(root, mission.id, 'will block');

        const blockedRun = await updateRunStatus(root, runningRun.id, 'blocked');
        const resumedRun = await updateRunStatus(root, runningRun.id, 'running');

        expect(blockedRun.status).toBe('blocked');
        expect(resumedRun.status).toBe('running');
    });
});
