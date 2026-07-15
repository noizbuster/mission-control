import type { Client } from '@libsql/client';
import { afterEach, describe, expect, it } from 'vitest';
import { expireSessionControlLease } from '../runtime/session-control-lease.js';
import {
    createSessionControlCallbackFence,
    createSessionControlOperation,
    readSessionControlOperation,
} from '../runtime/session-control-operation.js';
import {
    acquireOperationTestLease,
    cleanupOperationTestRuntimes,
    createOperationTestRuntime,
} from '../runtime/session-control-operation-test-support.js';
import { AsyncJobManager, type AsyncJobPersistenceMirror, type BackgroundJobHandle } from './async-job-manager.js';

afterEach(cleanupOperationTestRuntimes);

describe('AsyncJobManager callback fencing', () => {
    it('quarantines stale late completion before terminal mirror state is written', async () => {
        const runtime = await createOperationTestRuntime();
        const oldLease = await acquireOperationTestLease(runtime, 'owner-job-old', 1_000);
        const terminalWrites: Array<{ readonly status: string; readonly client: Client | undefined }> = [];
        const mirror: AsyncJobPersistenceMirror = {
            recordJob: (handle, client) => {
                if (isTerminal(handle)) terminalWrites.push({ status: handle.status, client });
            },
        };
        let release: ((result: { status: 'completed'; output: string }) => void) | undefined;
        const manager = new AsyncJobManager(1, { mirror });
        const handle = manager.startJob({
            sessionId: oldLease.sessionId,
            controlEpoch: {
                dbIdentity: oldLease.dbIdentity,
                sessionId: oldLease.sessionId,
                ownerId: oldLease.ownerId,
                ownerEpoch: oldLease.epoch,
                callbackFence: createSessionControlCallbackFence({
                    runtime,
                    lease: oldLease,
                    operationId: 'operation-job-stale',
                    nowWallMs: () => 2_100,
                }),
            },
            execute: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        await createSessionControlOperation({
            runtime,
            lease: oldLease,
            operationId: 'operation-job-stale',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: [`job:${handle.jobId}`],
            nowWallMs: 1_100,
        });
        await expireSessionControlLease({ runtime, lease: oldLease, nowWallMs: 2_000 });
        await acquireOperationTestLease(runtime, 'owner-job-new', 2_000);

        const awaited = manager.awaitJob(handle.jobId);
        release?.({ status: 'completed', output: 'late' });

        await expect(awaited).rejects.toMatchObject({ name: 'QuarantinedJobSettlementError' });
        expect(terminalWrites).toEqual([]);
        expect(handle.status).toBe('running');
        runtime.close();
    });

    it('persists truthful operator cancellation only after execution releases', async () => {
        const terminalStatuses: string[] = [];
        const mirror: AsyncJobPersistenceMirror = {
            recordJob: (handle) => {
                if (isTerminal(handle)) terminalStatuses.push(handle.status);
            },
        };
        let release: ((result: { status: 'completed'; output: string }) => void) | undefined;
        const manager = new AsyncJobManager(1, { mirror });
        const handle = manager.startJob({
            sessionId: 'session-job-cancel',
            execute: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });

        manager.cancelJob(handle.jobId, 'operator_aborted');
        expect(terminalStatuses).toEqual([]);
        expect(handle.status).toBe('running');
        release?.({ status: 'completed', output: 'released' });
        const settled = await manager.awaitJob(handle.jobId);

        expect(settled.status).toBe('cancelled');
        expect(settled.cancellationReason).toBe('operator_aborted');
        expect(terminalStatuses).toEqual(['cancelled']);
    });

    it('keeps default controlled cancellation unfenced until execution settles', async () => {
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-default-cancel', 1_000);
        const terminalClients: Array<Client | undefined> = [];
        const manager = new AsyncJobManager(1, {
            mirror: {
                recordJob: (handle, client) => {
                    if (isTerminal(handle)) terminalClients.push(client);
                },
            },
        });
        const handle = manager.startJob({
            sessionId: lease.sessionId,
            controlEpoch: controlEpoch(runtime, lease, 'operation-default-cancel'),
            execute: (signal) =>
                new Promise((_resolve, reject) => {
                    signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
                }),
        });
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-default-cancel',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: [`job:${handle.jobId}`],
            nowWallMs: 1_100,
        });

        manager.cancelJob(handle.jobId);

        expect(handle.status).toBe('running');
        expect(terminalClients).toEqual([]);
        const settled = await manager.awaitJob(handle.jobId);
        expect(settled.status).toBe('cancelled');
        expect(terminalClients).toHaveLength(1);
        expect(terminalClients[0]).toBeDefined();
        runtime.close();
    });

    it('quarantines stale queued cancellation without durable write and settles the local handle', async () => {
        const runtime = await createOperationTestRuntime();
        const oldLease = await acquireOperationTestLease(runtime, 'owner-queued-old', 1_000);
        const terminalWrites: string[] = [];
        const manager = new AsyncJobManager(1, {
            mirror: {
                recordJob: (handle) => {
                    if (isTerminal(handle)) terminalWrites.push(handle.status);
                },
            },
        });
        const blocker = manager.startJob({ sessionId: 'blocker', execute: () => new Promise(() => undefined) });
        const queued = manager.startJob({
            sessionId: oldLease.sessionId,
            controlEpoch: controlEpoch(runtime, oldLease, 'operation-queued-stale'),
            execute: async () => ({ status: 'completed', output: 'must not run' }),
        });
        await createSessionControlOperation({
            runtime,
            lease: oldLease,
            operationId: 'operation-queued-stale',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: [`job:${queued.jobId}`],
            nowWallMs: 1_100,
        });
        await expireSessionControlLease({ runtime, lease: oldLease, nowWallMs: 2_000 });
        await acquireOperationTestLease(runtime, 'owner-queued-new', 2_000);

        const original = { ...queued };
        const awaited = manager.awaitJob(queued.jobId);
        manager.cancelJob(queued.jobId, 'operator_aborted');

        await expect(awaited).rejects.toMatchObject({ name: 'QuarantinedJobSettlementError' });
        expect(queued).toEqual(original);
        expect(terminalWrites).toEqual([]);
        expect(blocker.status).toBe('running');
        runtime.close();
    });

    it('commits accepted queued cancellation through the fence before resolving awaiters', async () => {
        const runtime = await createOperationTestRuntime();
        const lease = await acquireOperationTestLease(runtime, 'owner-queued-live', 1_000);
        const terminalClients: Array<Client | undefined> = [];
        const manager = new AsyncJobManager(1, {
            mirror: {
                recordJob: (handle, client) => {
                    if (isTerminal(handle)) terminalClients.push(client);
                },
            },
        });
        manager.startJob({ sessionId: 'blocker-live', execute: () => new Promise(() => undefined) });
        const queued = manager.startJob({
            sessionId: lease.sessionId,
            controlEpoch: controlEpoch(runtime, lease, 'operation-queued-live'),
            execute: async () => ({ status: 'completed', output: 'must not run' }),
        });
        await createSessionControlOperation({
            runtime,
            lease,
            operationId: 'operation-queued-live',
            barrierKind: 'all_mutations',
            deadlineWallMs: 20_000,
            capturedHandleIds: [`job:${queued.jobId}`],
            nowWallMs: 1_100,
        });

        manager.cancelJob(queued.jobId, 'operator_aborted');
        const settled = await manager.awaitJob(queued.jobId);

        expect(settled.status).toBe('cancelled');
        expect(terminalClients).toHaveLength(1);
        expect(terminalClients[0]).toBeDefined();
        expect(
            await readSessionControlOperation(runtime, lease.dbIdentity, lease.sessionId, 'operation-queued-live'),
        ).toMatchObject({ settledHandleIds: [`job:${queued.jobId}`] });
        runtime.close();
    });
});

function isTerminal(handle: BackgroundJobHandle): boolean {
    return handle.status === 'completed' || handle.status === 'failed' || handle.status === 'cancelled';
}

function controlEpoch(
    runtime: Parameters<typeof createSessionControlCallbackFence>[0]['runtime'],
    lease: Parameters<typeof createSessionControlCallbackFence>[0]['lease'],
    operationId: string,
) {
    return {
        dbIdentity: lease.dbIdentity,
        sessionId: lease.sessionId,
        ownerId: lease.ownerId,
        ownerEpoch: lease.epoch,
        callbackFence: createSessionControlCallbackFence({ runtime, lease, operationId, nowWallMs: () => 2_100 }),
    };
}
