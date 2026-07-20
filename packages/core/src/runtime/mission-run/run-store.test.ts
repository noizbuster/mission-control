// allow: SIZE_OK -- HEAD 334 -> current 449 pure LOC; one durable Run-store transition and compatibility-import state-machine matrix.
import { type Run, RunSchema } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createObservabilityRedactor } from '../../providers/observability-redactor';
import { readRunFromDb, writeRunToDb } from './mission-run-db';
import type { MissionRunStoreLocation } from './mission-run-store-location';
import { makeTempRoot, seedMcRoot } from './mission-run-test-support';
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
} from './run-store';
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
        const root = seedMcRoot(makeTempRoot());
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
        const root = seedMcRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-1');

        const read = await readRun(root, run.id);

        expect(read).toEqual(run);
    });

    it('redacts terminal reasons at direct store boundaries and clears them from nonterminal Runs', async () => {
        const root = seedMcRoot(makeTempRoot());
        const pending = RunSchema.parse({
            id: crypto.randomUUID(),
            missionId: 'mission-safe-reason',
            status: 'pending',
            terminalReason: 'Bearer secret-token-value',
        });
        const created = await createRun(root, pending);
        await updateRunStatus(root, created.id, 'running');

        const failed = await updateRunStatus(root, created.id, 'failed', {
            terminalReason: `Bearer secret-token-value ${'x'.repeat(5000)}`,
        });

        expect(created.terminalReason).toBeUndefined();
        expect(failed.terminalReason).not.toContain('secret-token-value');
        expect(failed.terminalReason).toContain('[REDACTED_CREDENTIAL]');
        expect(failed.terminalReason).toHaveLength(4096);
    });

    it('redacts configured credentials before persisting Run updates', async () => {
        const credential = ['run', 'update', 'credential'].join('_');
        const root = seedMcRoot(makeTempRoot());
        const location = {
            ...root,
            observabilityRedactor: createObservabilityRedactor({ secrets: [credential] }),
        };
        const pending = await seedRun(location, 'mission-update-redaction');
        await updateRunStatus(location, pending.id, 'running');

        await updateRunStatus(location, pending.id, 'failed', {
            terminalReason: `failed with ${credential}`,
        });
        const rawPersisted = await readRunFromDb(location.dataDir, pending.id);

        expect(JSON.stringify(rawPersisted)).toContain('[REDACTED_CREDENTIAL]');
        expect(JSON.stringify(rawPersisted)).not.toContain(credential);
    });

    it('sanitizes canonical rows on read and same-status no-op returns', async () => {
        const root = seedMcRoot(makeTempRoot());
        const raw = RunSchema.parse({
            id: crypto.randomUUID(),
            missionId: 'mission-canonical-safe-reason',
            status: 'failed',
            terminalReason: `Bearer secret-token-value ${'x'.repeat(5000)}`,
        });
        await writeRunToDb(root.dataDir, raw);

        const read = await readRun(root, raw.id);
        const duplicate = await updateRunStatus(root, raw.id, 'failed');

        expect(read.terminalReason).not.toContain('secret-token-value');
        expect(read.terminalReason).toHaveLength(4096);
        expect(duplicate).toEqual(read);
    });

    it('throws RunStoreError(run_missing) for unknown id', async () => {
        const root = seedMcRoot(makeTempRoot());
        await expect(readRun(root, 'nonexistent')).rejects.toMatchObject({
            code: 'run_missing',
        });
    });

    it('fails closed on invalid legacy JSON', async () => {
        const root = seedMcRoot(makeTempRoot());
        const filePath = runFilePath(root.mcRoot, 'bad');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, '{ broken');

        await expect(readRun(root, 'bad')).rejects.toMatchObject({
            code: 'legacy_run_corrupt',
        });
        expect(readFileSync(filePath, 'utf8')).toBe('{ broken');
    });

    it('fails closed on invalid UTF-8 in compatible Run JSON', async () => {
        const root = seedMcRoot(makeTempRoot());
        const filePath = runFilePath(root.mcRoot, 'invalid-utf8');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, Buffer.from([0xff]));

        await expect(readRun(root, 'invalid-utf8')).rejects.toMatchObject({ code: 'legacy_run_read_failed' });
    });

    it('rejects traversal in compatible Run ids', async () => {
        const root = seedMcRoot(makeTempRoot());

        await expect(readRun(root, '../outside')).rejects.toMatchObject({ code: 'invalid_run_id' });
    });

    it.skipIf(process.platform === 'win32')('rejects symlinked compatible Run records', async () => {
        const root = seedMcRoot(makeTempRoot());
        const filePath = runFilePath(root.mcRoot, 'symlinked-run');
        const externalPath = join(root.mcRoot, 'external-run.json');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(externalPath, JSON.stringify({ id: 'symlinked-run', missionId: 'mission-1' }));
        symlinkSync(externalPath, filePath);

        await expect(readRun(root, 'symlinked-run')).rejects.toMatchObject({ code: 'legacy_run_unsafe_source' });
    });

    it.skipIf(process.platform === 'win32')('rejects a symlinked compatible Runs directory', async () => {
        const root = seedMcRoot(makeTempRoot());
        const externalRuns = join(root.mcRoot, 'external-runs');
        mkdirSync(externalRuns, { recursive: true });
        writeFileSync(
            join(externalRuns, 'outside-run.json'),
            JSON.stringify({ id: 'outside-run', missionId: 'mission-1' }),
        );
        symlinkSync(externalRuns, join(root.mcRoot, '.mc', 'runs'));

        await expect(readRun(root, 'outside-run')).rejects.toMatchObject({ code: 'legacy_run_unsafe_source' });
    });

    it('rejects a compatible Run whose payload id differs from its filename', async () => {
        const root = seedMcRoot(makeTempRoot());
        const filePath = runFilePath(root.mcRoot, 'requested-run');
        mkdirSync(join(filePath, '..'), { recursive: true });
        writeFileSync(filePath, JSON.stringify({ id: 'different-run', missionId: 'mission-1' }));

        await expect(readRun(root, 'requested-run')).rejects.toMatchObject({ code: 'legacy_run_corrupt' });
    });

    it('imports an active JSON-only run before operational status updates and leaves the source untouched', async () => {
        const root = seedMcRoot(makeTempRoot());
        const filePath = runFilePath(root.mcRoot, 'json-active');
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

    it('redacts configured credentials while importing an on-demand compatible Run', async () => {
        const baseLocation = seedMcRoot(makeTempRoot());
        const credential = ['compatible', 'run', 'credential'].join('_');
        const location = {
            ...baseLocation,
            observabilityRedactor: createObservabilityRedactor({ secrets: [credential] }),
        };
        const filePath = runFilePath(location.mcRoot, 'json-redacted');
        mkdirSync(join(filePath, '..'), { recursive: true });
        const source = JSON.stringify({
            id: 'json-redacted',
            missionId: 'mission-redacted',
            status: 'failed',
            prompt: `retry ${credential}`,
            terminalReason: `failed ${credential}`,
            endedAt: '2026-07-01T00:00:00.000Z',
        });
        writeFileSync(filePath, source, 'utf8');

        const imported = await readRun(location, 'json-redacted');

        expect(JSON.stringify(imported)).toContain('[REDACTED_CREDENTIAL]');
        expect(JSON.stringify(imported)).not.toContain(credential);
        expect(readFileSync(filePath, 'utf8')).toContain(credential);
    });

    it('does not overwrite a canonical row when a compatibility import loses a race', async () => {
        const root = seedMcRoot(makeTempRoot());
        const canonical = RunSchema.parse({
            id: 'json-import-race',
            missionId: 'mission-1',
            status: 'running',
            sessionId: 'session-import-race',
            sessionRunId: 'owner-canonical',
        });
        const staleCompatibleRecord = RunSchema.parse({
            id: canonical.id,
            missionId: canonical.missionId,
            status: 'running',
            sessionId: canonical.sessionId,
        });
        await writeRunToDb(root.dataDir, canonical);

        await writeRunToDb(root.dataDir, staleCompatibleRecord, { conflict: 'ignore' });

        expect((await readRun(root, canonical.id)).sessionRunId).toBe('owner-canonical');
    });

    it('auto-sets startedAt on first running transition', async () => {
        const root = seedMcRoot(makeTempRoot());
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
        const root = seedMcRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-1', 'pending');
        await updateRunStatus(root, run.id, 'running', {}, { now: () => '2026-01-01T00:00:00.000Z' });
        await updateRunStatus(root, run.id, 'blocked', {}, { now: () => '2026-01-01T01:00:00.000Z' });

        const resumed = await updateRunStatus(root, run.id, 'running', {}, { now: () => '2026-01-01T02:00:00.000Z' });

        expect(resumed.startedAt).toBe('2026-01-01T00:00:00.000Z');
    });

    it('auto-sets endedAt on terminal transition', async () => {
        const root = seedMcRoot(makeTempRoot());
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

    it('keeps same-status terminal transitions as true idempotent no-ops', async () => {
        const root = seedMcRoot(makeTempRoot());
        const run = await seedRun(root, 'mission-1', 'pending');
        await updateRunStatus(root, run.id, 'running');
        const cancelled = await updateRunStatus(
            root,
            run.id,
            'cancelled',
            { terminalReason: 'operator_aborted' },
            { now: () => '2026-01-01T12:00:00.000Z' },
        );

        const duplicate = await updateRunStatus(
            root,
            run.id,
            'cancelled',
            { terminalReason: 'run interrupted' },
            { now: () => '2026-01-01T13:00:00.000Z' },
        );

        expect(duplicate).toEqual(cancelled);
        expect(duplicate.terminalReason).toBe('operator_aborted');
        expect(duplicate.endedAt).toBe('2026-01-01T12:00:00.000Z');
    });

    it('serializes concurrent terminal transitions without overwriting the winner', async () => {
        const root = seedMcRoot(makeTempRoot());
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
        const root = seedMcRoot(makeTempRoot());
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
        const root = seedMcRoot(makeTempRoot());
        await seedRun(root, 'mission-a');
        await seedRun(root, 'mission-a');
        await seedRun(root, 'mission-b');

        const runs = await listRunsForMission(root, 'mission-a');

        expect(runs).toHaveLength(2);
        expect(runs.every((r) => r.missionId === 'mission-a')).toBe(true);
    });

    it('listRunsForMission returns empty array when directory does not exist', async () => {
        const root = seedMcRoot(makeTempRoot());
        const runs = await listRunsForMission(root, 'any');
        expect(runs).toEqual([]);
    });

    it('persists parentRunId, childAgentId, and childKind on a child run', async () => {
        const root = seedMcRoot(makeTempRoot());
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
        const root = seedMcRoot(makeTempRoot());

        const run = await seedRun(root, 'mission-1');

        const read = await readRun(root, run.id);
        expect(read.parentRunId).toBeUndefined();
        expect(read.childAgentId).toBeUndefined();
        expect(read.childKind).toBeUndefined();
    });

    it('listRunsForMission filters by parentId returning only matching children', async () => {
        const root = seedMcRoot(makeTempRoot());
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
        const root = seedMcRoot(makeTempRoot());
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
    it('RunStoreError extends McPersistenceError', () => {
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
