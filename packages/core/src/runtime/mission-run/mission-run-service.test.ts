import { RunSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { openLocalLibsqlDb } from '../../db/local-libsql-db';
import { openMissionControlDb } from '../../db/mission-control-db';
import { localSessionDbPath, localSessionDbUrl } from '../../memory/local-session-store-paths';
import { TursoPersistentStore } from '../../memory/turso-persistent-store';
import { blockRun, cancelRun, completeRun, failRun, materializeMission, startRun } from './mission-run-service';
import { makeTempRoot, makeTestWorkflowSpec, seedOmoRoot } from './mission-run-test-support';
import { createMission, missionFilePath, readMission } from './mission-store';
import {
    createRun,
    findMostRecentFailedRun,
    listRunsForMission,
    MissionRunTransitionError,
    readRun,
    runFilePath,
    updateRunStatus,
} from './run-store';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

describe('mission-run lifecycle', () => {
    it('transitions pending -> running -> completed with cost and terminal reason', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);

        const runningRun = await startRun(root, mission.id, 'do the thing', { sessionId: 'session_lifecycle' });

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

    it('redacts and bounds terminal reasons at the Run persistence boundary', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const runningRun = await startRun(root, mission.id, 'try and fail safely');

        const failedRun = await failRun(root, runningRun.id, `Bearer secret-token-value ${'x'.repeat(5000)}`);

        expect(failedRun.terminalReason).not.toContain('secret-token-value');
        expect(failedRun.terminalReason).toContain('[REDACTED_CREDENTIAL]');
        expect(failedRun.terminalReason).toHaveLength(4096);
    });

    it('transitions running -> cancelled with terminal reason', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const runningRun = await startRun(root, mission.id, 'start then cancel');

        const cancelledRun = await cancelRun(root, runningRun.id, 'operator interrupted workflow');

        expect(cancelledRun.status).toBe('cancelled');
        expect(cancelledRun.terminalReason).toBe('operator interrupted workflow');
        expect(cancelledRun.endedAt).toBeDefined();
    });

    it('persists the initiating prompt on the Run so retry can recover it', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);

        const runningRun = await startRun(root, mission.id, 'fix the @-autocomplete bug');

        expect((await readRun(root, runningRun.id)).prompt).toBe('fix the @-autocomplete bug');
    });

    it('persists records in the shared local Mission Control DB across reopen', async () => {
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

    it('finds the most recent failed Run and ignores completed Runs', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        expect(await findMostRecentFailedRun(root)).toBeUndefined();
        const completed = await startRun(root, mission.id, 'completed attempt');
        await completeRun(root, completed.id);
        const first = await startRun(root, mission.id, 'first attempt');
        await failRun(root, first.id, 'boom');
        const second = await startRun(root, mission.id, 'second attempt');
        await failRun(root, second.id, 'boom again');

        const latest = await findMostRecentFailedRun(root);

        expect(latest).toBeDefined();
        expect(latest?.id).toBe(second.id);
        expect(latest?.prompt).toBe('second attempt');
    });

    it('returns no recent failed Run when only completed Runs exist', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const run = await startRun(root, mission.id, 'succeeds');
        await completeRun(root, run.id);

        expect(await findMostRecentFailedRun(root)).toBeUndefined();
    });

    it('rejects an invalid pending -> completed transition', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const pending = RunSchema.parse({ id: crypto.randomUUID(), missionId: mission.id, status: 'pending' as const });
        await createRun(root, pending);

        await expect(updateRunStatus(root, pending.id, 'completed')).rejects.toBeInstanceOf(MissionRunTransitionError);
    });

    it('rejects transitions from a terminal state', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const running = await startRun(root, mission.id, 'complete then try to resume');
        await completeRun(root, running.id);

        await expect(updateRunStatus(root, running.id, 'running')).rejects.toBeInstanceOf(MissionRunTransitionError);
    });

    it('supports blocked -> running transition', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const runningRun = await startRun(root, mission.id, 'will block');

        expect((await updateRunStatus(root, runningRun.id, 'blocked')).status).toBe('blocked');
        expect((await updateRunStatus(root, runningRun.id, 'running')).status).toBe('running');
    });

    it('links an explicitly supplied session and leaves a Run unlinked otherwise', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);

        const linked = await startRun(root, mission.id, 'linked', { sessionId: 'session_actual' });
        const unlinked = await startRun(root, mission.id, 'unlinked');

        expect(linked.sessionId).toBe('session_actual');
        expect(unlinked.sessionId).toBeUndefined();
    });

    it('blocks a running Run without terminal metadata', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const running = await startRun(root, mission.id, 'await approval', { sessionId: 'session_blocked' });

        await blockRun(root, running.id);
        const blocked = await readRun(root, running.id);
        expect(blocked.status).toBe('blocked');
        expect(blocked.terminalReason).toBeUndefined();
        expect(blocked.sessionId).toBe('session_blocked');
    });

    it('rejects a blocked transition that tries to replace the attached owner', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const running = await startRun(root, mission.id, 'preserve owner', { sessionId: 'session_owner' });
        await blockRun(root, running.id, { sessionId: 'session_owner', sessionRunId: 'owner_first' });
        await updateRunStatus(root, running.id, 'running');

        await expect(
            blockRun(root, running.id, { sessionId: 'session_owner', sessionRunId: 'owner_second' }),
        ).rejects.toMatchObject({ code: 'run_session_owner_mismatch' });
        expect(await readRun(root, running.id)).toMatchObject({
            status: 'running',
            sessionRunId: 'owner_first',
        });
    });

    it('does not retain an approval reason after a blocked Run resumes and completes', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const running = await startRun(root, mission.id, 'resume after approval');

        await blockRun(root, running.id);
        await updateRunStatus(root, running.id, 'running');
        await completeRun(root, running.id);
        const completed = await readRun(root, running.id);
        expect(completed.status).toBe('completed');
        expect(completed.terminalReason).toBeUndefined();
    });
});
