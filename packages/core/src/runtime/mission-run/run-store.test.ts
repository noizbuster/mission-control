import { type Run, RunSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { MissionRunStoreLocation } from './mission-run-store-location.js';
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
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

async function seedRun(
    location: MissionRunStoreLocation,
    missionId: string,
    status: Run['status'] = 'pending',
): Promise<Run> {
    const run = RunSchema.parse({
        id: crypto.randomUUID(),
        missionId,
        status,
    });
    return createRun(location, run);
}

describe('run-store', () => {
    it('exposes the exact cancellable run transition map', () => {
        expect(ALLOWED_RUN_TRANSITIONS).toEqual({
            pending: ['running', 'cancelled'],
            running: ['blocked', 'completed', 'failed', 'cancelled'],
            blocked: ['running', 'cancelled'],
            completed: [],
            failed: [],
            cancelled: [],
        });
    });

    it.each(['pending', 'blocked'] as const)('cancels a %s run with terminal timestamps and reason', async (status) => {
        const root = seedOmoRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-cancel', 'pending');
        if (status === 'blocked') {
            await updateRunStatus(root, run.id, 'running');
            await updateRunStatus(root, run.id, 'blocked');
        }

        const cancelled = await updateRunStatus(
            root,
            run.id,
            'cancelled',
            { terminalReason: 'operator_aborted' },
            { now: () => '2026-07-11T12:00:00.000Z' },
        );

        expect(cancelled).toMatchObject({
            status: 'cancelled',
            endedAt: '2026-07-11T12:00:00.000Z',
            terminalReason: 'operator_aborted',
        });
    });

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

    it('fails closed on invalid legacy JSON', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const filePath = runFilePath(root.omoRoot, 'bad');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, '{ broken');

        await expect(readRun(root, 'bad')).rejects.toMatchObject({
            code: 'legacy_run_corrupt',
        });
        expect(readFileSync(filePath, 'utf8')).toBe('{ broken');
    });

    it('fails closed on invalid UTF-8 in compatible Run JSON', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const filePath = runFilePath(root.omoRoot, 'invalid-utf8');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, Buffer.from([0xff]));

        await expect(readRun(root, 'invalid-utf8')).rejects.toMatchObject({ code: 'legacy_run_read_failed' });
    });

    it('rejects traversal in compatible Run ids', async () => {
        const root = seedOmoRoot(makeTempRoot());

        await expect(readRun(root, '../outside')).rejects.toMatchObject({ code: 'invalid_run_id' });
    });

    it.skipIf(process.platform === 'win32')('rejects symlinked compatible Run records', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const filePath = runFilePath(root.omoRoot, 'symlinked-run');
        const externalPath = join(root.omoRoot, 'external-run.json');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(externalPath, JSON.stringify({ id: 'symlinked-run', missionId: 'mission-1' }));
        symlinkSync(externalPath, filePath);

        await expect(readRun(root, 'symlinked-run')).rejects.toMatchObject({ code: 'legacy_run_unsafe_source' });
    });

    it.skipIf(process.platform === 'win32')('rejects a symlinked compatible Runs directory', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const externalRuns = join(root.omoRoot, 'external-runs');
        mkdirSync(externalRuns, { recursive: true });
        writeFileSync(
            join(externalRuns, 'outside-run.json'),
            JSON.stringify({ id: 'outside-run', missionId: 'mission-1' }),
        );
        symlinkSync(externalRuns, join(root.omoRoot, '.omo', 'runs'));

        await expect(readRun(root, 'outside-run')).rejects.toMatchObject({ code: 'legacy_run_unsafe_source' });
    });

    it('rejects a compatible Run whose payload id differs from its filename', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const filePath = runFilePath(root.omoRoot, 'requested-run');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, JSON.stringify({ id: 'different-run', missionId: 'mission-1' }));

        await expect(readRun(root, 'requested-run')).rejects.toMatchObject({ code: 'legacy_run_corrupt' });
    });

    it('imports an active JSON-only run before operational status updates and leaves the source untouched', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const filePath = runFilePath(root.omoRoot, 'json-active');
        mkdirSync(join(filePath, '..'), { recursive: true });
        const source = JSON.stringify({
            id: 'json-active',
            missionId: 'mission-1',
            status: 'running',
            startedAt: '2026-07-01T00:00:00.000Z',
        });
        writeFileSync(filePath, source, 'utf8');

        const imported = await readRun(root, 'json-active');
        const cancelled = await updateRunStatus(
            root,
            imported.id,
            'cancelled',
            { terminalReason: 'operator_aborted' },
            { now: () => '2026-07-01T01:00:00.000Z' },
        );

        expect(imported.status).toBe('running');
        expect(cancelled.status).toBe('cancelled');
        expect(cancelled.terminalReason).toBe('operator_aborted');
        expect(readFileSync(filePath, 'utf8')).toBe(source);
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

    it('serializes concurrent terminal transitions without overwriting the winner', async () => {
        const root = seedOmoRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-1', 'pending');
        await updateRunStatus(root, run.id, 'running');

        const outcomes = await Promise.allSettled([
            updateRunStatus(root, run.id, 'completed'),
            updateRunStatus(root, run.id, 'failed'),
        ]);
        const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
        const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');

        expect(fulfilled).toHaveLength(1);
        expect(rejected).toHaveLength(1);
        expect(rejected[0]).toMatchObject({ reason: { name: 'MissionRunTransitionError' } });
        expect((await readRun(root, run.id)).status).toBe(fulfilled[0]?.value.status);
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
    it('pending allows running or cancellation', () => {
        expect(ALLOWED_RUN_TRANSITIONS.pending).toEqual(['running', 'cancelled']);
    });

    it('running allows blocked, completed, failed, cancelled', () => {
        expect(ALLOWED_RUN_TRANSITIONS.running).toContain('blocked');
        expect(ALLOWED_RUN_TRANSITIONS.running).toContain('completed');
        expect(ALLOWED_RUN_TRANSITIONS.running).toContain('failed');
        expect(ALLOWED_RUN_TRANSITIONS.running).toContain('cancelled');
    });

    it('blocked allows running or cancellation', () => {
        expect(ALLOWED_RUN_TRANSITIONS.blocked).toEqual(['running', 'cancelled']);
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
