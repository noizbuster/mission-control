import { type Run, RunSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { makeTempRoot, seedOmoRoot } from './mission-run-test-support.js';
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
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

async function seedRun(root: string, missionId: string, status: Run['status'] = 'pending'): Promise<Run> {
    const run = RunSchema.parse({
        id: crypto.randomUUID(),
        missionId,
        status,
    });
    return createRun(root, run);
}

describe('run-store', () => {
    it('roundtrips a Run through create and read', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-1');

        const read = await readRun(root, run.id);

        expect(read).toEqual(run);
    });

    it('throws RunStoreError(run_missing) for unknown id', async () => {
        const root = seedOmoRoot(makeTempRoot());
        await expect(readRun(root, 'nonexistent')).rejects.toMatchObject({
            code: 'run_missing',
        });
    });

    it('throws RunStoreError(run_corrupt) for invalid JSON', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const filePath = runFilePath(root, 'bad');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, '{ broken');

        await expect(readRun(root, 'bad')).rejects.toMatchObject({
            code: 'run_corrupt',
        });
    });

    it('auto-sets startedAt on first running transition', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-1', 'pending');
        expect(run.startedAt).toBeUndefined();

        const running = await updateRunStatus(
            root,
            run.id,
            'running',
            {},
            {
                now: () => '2026-01-01T00:00:00.000Z',
            },
        );

        expect(running.startedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('does not overwrite startedAt on blocked to running resume', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-1', 'pending');
        await updateRunStatus(root, run.id, 'running', {}, { now: () => '2026-01-01T00:00:00.000Z' });
        await updateRunStatus(root, run.id, 'blocked', {}, { now: () => '2026-01-01T01:00:00.000Z' });

        const resumed = await updateRunStatus(root, run.id, 'running', {}, { now: () => '2026-01-01T02:00:00.000Z' });

        expect(resumed.startedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('auto-sets endedAt on terminal transition', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-1', 'pending');
        await updateRunStatus(root, run.id, 'running');

        const completed = await updateRunStatus(
            root,
            run.id,
            'completed',
            { terminalReason: 'done' },
            { now: () => '2026-01-01T12:00:00.000Z' },
        );

        expect(completed.endedAt).toBe('2026-01-01T12:00:00.000Z');
    });

    it('applies patch fields during status transition', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-1', 'pending');
        await updateRunStatus(root, run.id, 'running');
        const patch: RunPatch = {
            cost: { cents: 200, inputTokens: 50, outputTokens: 25, modelCalls: 1 },
            terminalReason: 'budget reached',
        };

        const completed = await updateRunStatus(root, run.id, 'completed', patch);

        expect(completed.cost.cents).toBe(200);
        expect(completed.cost.modelCalls).toBe(1);
        expect(completed.terminalReason).toBe('budget reached');
    });

    it('lists runs filtered by missionId', async () => {
        const root = seedOmoRoot(makeTempRoot());
        await seedRun(root, 'mission-a');
        await seedRun(root, 'mission-a');
        await seedRun(root, 'mission-b');

        const runs = await listRunsForMission(root, 'mission-a');

        expect(runs).toHaveLength(2);
        expect(runs.every((r) => r.missionId === 'mission-a')).toBe(true);
    });

    it('listRunsForMission returns empty array when directory does not exist', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const runs = await listRunsForMission(root, 'any');
        expect(runs).toEqual([]);
    });

    it('persists parentRunId, childAgentId, and childKind on a child run', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const parent = await seedRun(root, 'mission-1');
        const childRun = RunSchema.parse({
            id: crypto.randomUUID(),
            missionId: 'mission-1',
            parentRunId: parent.id,
            childAgentId: 'executor',
            childKind: 'sub',
        });

        await createRun(root, childRun);

        const read = await readRun(root, childRun.id);
        expect(read.parentRunId).toBe(parent.id);
        expect(read.childAgentId).toBe('executor');
        expect(read.childKind).toBe('sub');
    });

    it('omits parentRunId, childAgentId, and childKind when not provided', async () => {
        const root = seedOmoRoot(makeTempRoot());

        const run = await seedRun(root, 'mission-1');

        const read = await readRun(root, run.id);
        expect(read.parentRunId).toBeUndefined();
        expect(read.childAgentId).toBeUndefined();
        expect(read.childKind).toBeUndefined();
    });

    it('listRunsForMission filters by parentId returning only matching children', async () => {
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

        const children = await listRunsForMission(root, 'mission-1', { parentId: parent.id });

        expect(children).toHaveLength(2);
        expect(children.every((r) => r.parentRunId === parent.id)).toBe(true);
    });

    it('listRunsForMission without filter returns all runs including children', async () => {
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

        const all = await listRunsForMission(root, 'mission-1');

        expect(all).toHaveLength(2);
        const ids = all.map((r) => r.id);
        expect(ids).toContain(parent.id);
        expect(ids).toContain(child.id);
    });
});

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

describe('run-store errors', () => {
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
