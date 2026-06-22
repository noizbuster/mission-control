import { MissionSchema, type Run, RunSchema, type WorkflowSpec, WorkflowSpecSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { completeRun, failRun, materializeMission, startRun } from './mission-run-service.js';
import {
    createMission,
    listMissions,
    type MissionPatch,
    MissionStoreError,
    missionFilePath,
    readMission,
    updateMission,
} from './mission-store.js';
import {
    ALLOWED_RUN_TRANSITIONS,
    createRun,
    listRunsForMission,
    MissionRunTransitionError,
    type RunPatch,
    RunStoreError,
    readRun,
    runFilePath,
    updateRunStatus,
} from './run-store.js';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempRoots: string[] = [];

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

function makeTempRoot(): string {
    const root = mkdtempSync(join(tmpdir(), 'mission-run-test-'));
    tempRoots.push(root);
    return root;
}

function seedOmoRoot(root: string): string {
    mkdirSync(join(root, '.omo'), { recursive: true });
    return root;
}

function makeTestWorkflowSpec(): WorkflowSpec {
    return WorkflowSpecSchema.parse({
        name: 'test-workflow',
        description: 'A test workflow',
        graph: {
            id: 'test-graph',
            entryNodeId: 'start',
            nodes: [{ id: 'start', kind: 'llm', label: 'Start' }],
        },
    });
}

function makeCategorizedWorkflowSpec(): WorkflowSpec {
    return WorkflowSpecSchema.parse({
        name: 'categorized-workflow',
        graph: {
            id: 'cat-graph',
            entryNodeId: 'entry',
            nodes: [{ id: 'entry', kind: 'llm' }],
        },
        categories: [{ id: 'quick', permissions: ['read', 'edit'] }],
        modes: [{ id: 'autopilot', policies: [] }],
    });
}

// ---------------------------------------------------------------------------
// materializeMission
// ---------------------------------------------------------------------------

describe('materializeMission', () => {
    it('creates a valid draft Mission from a WorkflowSpec', () => {
        // Given
        const spec = makeTestWorkflowSpec();

        // When
        const mission = materializeMission(spec);

        // Then
        expect(mission.id).toHaveLength(36); // UUID format
        expect(mission.name).toBe('test-workflow');
        expect(mission.description).toBe('A test workflow');
        expect(mission.status).toBe('draft');
        expect(mission.graph).toBeDefined();
        expect(mission.graph?.id).toBe('test-graph');
        expect(mission.workflowName).toBe('test-workflow');
        expect(mission.createdAt).toBeDefined();
        expect(mission.updatedAt).toBeDefined();
        expect(mission.capabilities).toEqual({ allow: [], deny: [] });
        // Re-validate through the schema to prove the output is well-formed.
        expect(() => MissionSchema.parse(mission)).not.toThrow();
    });

    it('derives capabilities from categories and modeDeclarations from modes', () => {
        // Given
        const spec = makeCategorizedWorkflowSpec();

        // When
        const mission = materializeMission(spec);

        // Then
        expect(mission.capabilities.allow).toContain('read');
        expect(mission.capabilities.allow).toContain('edit');
        expect(mission.modeDeclarations).toEqual([{ modeId: 'autopilot', active: true }]);
    });

    it('generates unique ids on repeated calls', () => {
        // Given
        const spec = makeTestWorkflowSpec();

        // When
        const mission1 = materializeMission(spec);
        const mission2 = materializeMission(spec);

        // Then
        expect(mission1.id).not.toBe(mission2.id);
    });
});

// ---------------------------------------------------------------------------
// Full lifecycle: materialize → createMission → startRun → completeRun
// ---------------------------------------------------------------------------

describe('mission-run lifecycle', () => {
    it('transitions pending → running → completed with cost and terminal reason', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);

        // When — startRun
        const runningRun = await startRun(root, mission.id, 'do the thing');

        // Then — run is running, mission is active
        expect(runningRun.status).toBe('running');
        expect(runningRun.missionId).toBe(mission.id);
        expect(runningRun.sessionId).toBeDefined();
        expect(runningRun.startedAt).toBeDefined();

        const activeMission = await readMission(root, mission.id);
        expect(activeMission.status).toBe('active');

        // When — completeRun
        const completedRun = await completeRun(root, runningRun.id, {
            cost: { cents: 150, inputTokens: 1000, outputTokens: 500, modelCalls: 3 },
            terminalReason: 'all steps done',
        });

        // Then — run is completed with cost + terminal reason + endedAt
        expect(completedRun.status).toBe('completed');
        expect(completedRun.cost.cents).toBe(150);
        expect(completedRun.cost.inputTokens).toBe(1000);
        expect(completedRun.cost.modelCalls).toBe(3);
        expect(completedRun.terminalReason).toBe('all steps done');
        expect(completedRun.endedAt).toBeDefined();
        expect(completedRun.startedAt).toBeDefined();
    });

    it('transitions running → failed with terminal reason', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const runningRun = await startRun(root, mission.id, 'try and fail');

        // When
        const failedRun = await failRun(root, runningRun.id, 'provider timeout');

        // Then
        expect(failedRun.status).toBe('failed');
        expect(failedRun.terminalReason).toBe('provider timeout');
        expect(failedRun.endedAt).toBeDefined();
    });

    it('throws MissionRunTransitionError on invalid transition (pending → completed)', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const run = RunSchema.parse({
            id: crypto.randomUUID(),
            missionId: mission.id,
            status: 'pending' as const,
        });
        await createRun(root, run);

        // When / Then
        await expect(updateRunStatus(root, run.id, 'completed')).rejects.toBeInstanceOf(MissionRunTransitionError);
    });

    it('throws MissionRunTransitionError when transitioning from a terminal state', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const runningRun = await startRun(root, mission.id, 'complete then try to resume');
        await completeRun(root, runningRun.id);

        // When / Then
        await expect(updateRunStatus(root, runningRun.id, 'running')).rejects.toBeInstanceOf(MissionRunTransitionError);
    });

    it('supports blocked → running transition', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const runningRun = await startRun(root, mission.id, 'will block');

        // When — block then resume
        const blockedRun = await updateRunStatus(root, runningRun.id, 'blocked');
        expect(blockedRun.status).toBe('blocked');

        const resumedRun = await updateRunStatus(root, runningRun.id, 'running');
        expect(resumedRun.status).toBe('running');
    });
});

// ---------------------------------------------------------------------------
// Mission store CRUD
// ---------------------------------------------------------------------------

describe('mission-store', () => {
    it('roundtrips a Mission through create and read', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());

        // When
        await createMission(root, mission);
        const read = await readMission(root, mission.id);

        // Then
        expect(read).toEqual(mission);
    });

    it('throws MissionStoreError(mission_missing) for unknown id', async () => {
        const root = seedOmoRoot(makeTempRoot());
        await expect(readMission(root, 'nonexistent')).rejects.toMatchObject({
            code: 'mission_missing',
        });
    });

    it('throws MissionStoreError(mission_corrupt) for invalid JSON', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const filePath = missionFilePath(root, 'bad');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, '{ not valid json');

        // When / Then
        await expect(readMission(root, 'bad')).rejects.toMatchObject({
            code: 'mission_corrupt',
        });
    });

    it('throws MissionStoreError(mission_corrupt) for schema-invalid content', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const filePath = missionFilePath(root, 'bad-schema');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, JSON.stringify({ id: 'bad-schema', name: 'missing fields' }));

        // When / Then
        await expect(readMission(root, 'bad-schema')).rejects.toMatchObject({
            code: 'mission_corrupt',
        });
    });

    it('updates a Mission with a patch and refreshes updatedAt', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const mission = materializeMission(makeTestWorkflowSpec());
        await createMission(root, mission);
        const patch: MissionPatch = { description: 'updated description', status: 'active' };

        // When
        const before = new Date(mission.updatedAt).getTime();
        const updated = await updateMission(root, mission.id, patch, {
            now: () => new Date(before + 5000).toISOString(),
        });

        // Then
        expect(updated.description).toBe('updated description');
        expect(updated.status).toBe('active');
        expect(new Date(updated.updatedAt).getTime()).toBe(before + 5000);
    });

    it('lists all persisted Missions', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const m1 = materializeMission(makeTestWorkflowSpec());
        const m2 = materializeMission(makeTestWorkflowSpec());
        await createMission(root, m1);
        await createMission(root, m2);

        // When
        const missions = await listMissions(root);

        // Then
        expect(missions).toHaveLength(2);
        const ids = missions.map((m) => m.id);
        expect(ids).toContain(m1.id);
        expect(ids).toContain(m2.id);
    });

    it('listMissions returns empty array when directory does not exist', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const missions = await listMissions(root);
        expect(missions).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Run store CRUD
// ---------------------------------------------------------------------------

describe('run-store', () => {
    async function seedRun(root: string, missionId: string, status: Run['status'] = 'pending'): Promise<Run> {
        const run = RunSchema.parse({
            id: crypto.randomUUID(),
            missionId,
            status,
        });
        return createRun(root, run);
    }

    it('roundtrips a Run through create and read', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-1');

        // When
        const read = await readRun(root, run.id);

        // Then
        expect(read).toEqual(run);
    });

    it('throws RunStoreError(run_missing) for unknown id', async () => {
        const root = seedOmoRoot(makeTempRoot());
        await expect(readRun(root, 'nonexistent')).rejects.toMatchObject({
            code: 'run_missing',
        });
    });

    it('throws RunStoreError(run_corrupt) for invalid JSON', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const filePath = runFilePath(root, 'bad');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, '{ broken');

        // When / Then
        await expect(readRun(root, 'bad')).rejects.toMatchObject({
            code: 'run_corrupt',
        });
    });

    it('auto-sets startedAt on first →running transition', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-1', 'pending');
        expect(run.startedAt).toBeUndefined();

        // When
        const running = await updateRunStatus(
            root,
            run.id,
            'running',
            {},
            {
                now: () => '2026-01-01T00:00:00.000Z',
            },
        );

        // Then
        expect(running.startedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('does not overwrite startedAt on blocked → running resume', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-1', 'pending');
        await updateRunStatus(
            root,
            run.id,
            'running',
            {},
            {
                now: () => '2026-01-01T00:00:00.000Z',
            },
        );
        await updateRunStatus(
            root,
            run.id,
            'blocked',
            {},
            {
                now: () => '2026-01-01T01:00:00.000Z',
            },
        );

        // When
        const resumed = await updateRunStatus(
            root,
            run.id,
            'running',
            {},
            {
                now: () => '2026-01-01T02:00:00.000Z',
            },
        );

        // Then
        expect(resumed.startedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('auto-sets endedAt on terminal transition', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-1', 'pending');
        await updateRunStatus(root, run.id, 'running');

        // When
        const completed = await updateRunStatus(
            root,
            run.id,
            'completed',
            { terminalReason: 'done' },
            { now: () => '2026-01-01T12:00:00.000Z' },
        );

        // Then
        expect(completed.endedAt).toBe('2026-01-01T12:00:00.000Z');
    });

    it('applies patch fields (cost, model) during status transition', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-1', 'pending');
        await updateRunStatus(root, run.id, 'running');

        const patch: RunPatch = {
            cost: { cents: 200, inputTokens: 50, outputTokens: 25, modelCalls: 1 },
            terminalReason: 'budget reached',
        };

        // When
        const completed = await updateRunStatus(root, run.id, 'completed', patch);

        // Then
        expect(completed.cost.cents).toBe(200);
        expect(completed.cost.modelCalls).toBe(1);
        expect(completed.terminalReason).toBe('budget reached');
    });

    it('lists runs filtered by missionId', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        await seedRun(root, 'mission-a');
        await seedRun(root, 'mission-a');
        await seedRun(root, 'mission-b');

        // When
        const runs = await listRunsForMission(root, 'mission-a');

        // Then
        expect(runs).toHaveLength(2);
        expect(runs.every((r) => r.missionId === 'mission-a')).toBe(true);
    });

    it('listRunsForMission returns empty array when directory does not exist', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const runs = await listRunsForMission(root, 'any');
        expect(runs).toEqual([]);
    });

    it('persists parentRunId, childAgentId, and childKind on a child run', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const parent = await seedRun(root, 'mission-1');
        const childRun = RunSchema.parse({
            id: crypto.randomUUID(),
            missionId: 'mission-1',
            parentRunId: parent.id,
            childAgentId: 'executor',
            childKind: 'sub',
        });

        // When
        await createRun(root, childRun);

        // Then
        const read = await readRun(root, childRun.id);
        expect(read.parentRunId).toBe(parent.id);
        expect(read.childAgentId).toBe('executor');
        expect(read.childKind).toBe('sub');
    });

    it('omits parentRunId, childAgentId, and childKind when not provided', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());

        // When
        const run = await seedRun(root, 'mission-1');

        // Then
        const read = await readRun(root, run.id);
        expect(read.parentRunId).toBeUndefined();
        expect(read.childAgentId).toBeUndefined();
        expect(read.childKind).toBeUndefined();
    });

    it('listRunsForMission filters by parentId returning only matching children', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const parent = await seedRun(root, 'mission-1');
        await createRun(
            root,
            RunSchema.parse({
                id: crypto.randomUUID(),
                missionId: 'mission-1',
                parentRunId: parent.id,
                childAgentId: 'a',
                childKind: 'sub',
            }),
        );
        await createRun(
            root,
            RunSchema.parse({
                id: crypto.randomUUID(),
                missionId: 'mission-1',
                parentRunId: parent.id,
                childAgentId: 'b',
                childKind: 'advisor',
            }),
        );
        await createRun(
            root,
            RunSchema.parse({
                id: crypto.randomUUID(),
                missionId: 'mission-1',
                parentRunId: 'other-parent',
                childAgentId: 'c',
                childKind: 'main',
            }),
        );

        // When
        const children = await listRunsForMission(root, 'mission-1', { parentId: parent.id });

        // Then
        expect(children).toHaveLength(2);
        expect(children.every((r) => r.parentRunId === parent.id)).toBe(true);
    });

    it('listRunsForMission without filter returns all runs including children', async () => {
        // Given
        const root = seedOmoRoot(makeTempRoot());
        const parent = await seedRun(root, 'mission-1');
        const child = await createRun(
            root,
            RunSchema.parse({
                id: crypto.randomUUID(),
                missionId: 'mission-1',
                parentRunId: parent.id,
                childAgentId: 'a',
                childKind: 'sub',
            }),
        );

        // When
        const all = await listRunsForMission(root, 'mission-1');

        // Then
        expect(all).toHaveLength(2);
        const ids = all.map((r) => r.id);
        expect(ids).toContain(parent.id);
        expect(ids).toContain(child.id);
    });
});

// ---------------------------------------------------------------------------
// ALLOWED_RUN_TRANSITIONS map
// ---------------------------------------------------------------------------

describe('ALLOWED_RUN_TRANSITIONS', () => {
    it('pending only allows running', () => {
        expect(ALLOWED_RUN_TRANSITIONS.pending).toEqual(['running']);
    });

    it('running allows blocked, completed, failed, cancelled', () => {
        expect(ALLOWED_RUN_TRANSITIONS.running).toContain('blocked');
        expect(ALLOWED_RUN_TRANSITIONS.running).toContain('completed');
        expect(ALLOWED_RUN_TRANSITIONS.running).toContain('failed');
        expect(ALLOWED_RUN_TRANSITIONS.running).toContain('cancelled');
    });

    it('blocked only allows running', () => {
        expect(ALLOWED_RUN_TRANSITIONS.blocked).toEqual(['running']);
    });

    it('terminal states have no outgoing transitions', () => {
        expect(ALLOWED_RUN_TRANSITIONS.completed).toEqual([]);
        expect(ALLOWED_RUN_TRANSITIONS.failed).toEqual([]);
        expect(ALLOWED_RUN_TRANSITIONS.cancelled).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// Error types are exported correctly
// ---------------------------------------------------------------------------

describe('error type exports', () => {
    it('MissionStoreError extends OmoPersistenceError', () => {
        const err = new MissionStoreError('test', 'test_code');
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe('test_code');
    });

    it('RunStoreError extends OmoPersistenceError', () => {
        const err = new RunStoreError('test', 'test_code');
        expect(err).toBeInstanceOf(Error);
        expect(err.code).toBe('test_code');
    });

    it('MissionRunTransitionError carries from/to status', () => {
        const err = new MissionRunTransitionError('bad', 'pending', 'completed');
        expect(err.fromStatus).toBe('pending');
        expect(err.toStatus).toBe('completed');
    });
});
