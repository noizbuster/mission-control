import { afterEach, describe, expect, it } from 'vitest';
import { createSessionControlOperation, readSessionControlOperation } from '../runtime/session-control-operation.js';
import { createSessionControlCallbackFence } from '../runtime/session-control-operation-settlement.js';
import {
    acquireOperationTestLease,
    cleanupOperationTestRuntimes,
    createOperationTestRuntime,
} from '../runtime/session-control-operation-test-support.js';
import { AsyncJobManager, type AsyncJobPersistenceMirror } from './async-job-manager.js';

afterEach(cleanupOperationTestRuntimes);

describe('AsyncJobManager controlled writer invariant', () => {
    it('fails a controlled running job without a persistence mirror and leaves its handle unsettled', async () => {
        const fixture = await runningFixture('job-no-mirror');
        const manager = new AsyncJobManager(1);
        let release: ((result: { status: 'completed'; output: string }) => void) | undefined;
        const handle = manager.startJob({
            sessionId: fixture.lease.sessionId,
            controlEpoch: fixture.epoch,
            execute: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        await fixture.createOperation(handle.jobId);

        release?.({ status: 'completed', output: 'not durable' });
        const settled = await manager.awaitJob(handle.jobId);

        expect(settled.status).toBe('failed');
        expect(settled.error).toContain('persistence mirror');
        expect(await fixture.operation()).toMatchObject({ settledHandleIds: [] });
        fixture.runtime.close();
    });

    it('fails queued cancellation when the mirror writer rejects and leaves its handle unsettled', async () => {
        const fixture = await runningFixture('queued-writer-reject');
        const mirror = rejectingMirror();
        const manager = new AsyncJobManager(1, { mirror: mirror.value });
        manager.startJob({ sessionId: 'queued-blocker', execute: () => new Promise(() => undefined) });
        const queued = manager.startJob({
            sessionId: fixture.lease.sessionId,
            controlEpoch: fixture.epoch,
            execute: async () => ({ status: 'completed', output: 'must not run' }),
        });
        await fixture.createOperation(queued.jobId);

        manager.cancelJob(queued.jobId, 'operator_aborted');
        const settled = await manager.awaitJob(queued.jobId);

        expect(settled.status).toBe('failed');
        expect(settled.error).toContain('mirror rejected');
        expect(mirror.durableWrites()).toBe(0);
        expect(await fixture.operation()).toMatchObject({ settledHandleIds: [] });
        fixture.runtime.close();
    });

    it('fails running completion when the mirror writer rejects and leaves its handle unsettled', async () => {
        const fixture = await runningFixture('running-writer-reject');
        const mirror = rejectingMirror();
        const manager = new AsyncJobManager(1, { mirror: mirror.value });
        let release: ((result: { status: 'completed'; output: string }) => void) | undefined;
        const handle = manager.startJob({
            sessionId: fixture.lease.sessionId,
            controlEpoch: fixture.epoch,
            execute: () =>
                new Promise((resolve) => {
                    release = resolve;
                }),
        });
        await fixture.createOperation(handle.jobId);

        release?.({ status: 'completed', output: 'not durable' });
        const settled = await manager.awaitJob(handle.jobId);

        expect(settled.status).toBe('failed');
        expect(settled.error).toContain('mirror rejected');
        expect(mirror.durableWrites()).toBe(0);
        expect(await fixture.operation()).toMatchObject({ settledHandleIds: [] });
        fixture.runtime.close();
    });
});

async function runningFixture(operationId: string) {
    const runtime = await createOperationTestRuntime();
    const lease = await acquireOperationTestLease(runtime, `owner-${operationId}`, 1_000);
    const epoch = {
        dbIdentity: lease.dbIdentity,
        sessionId: lease.sessionId,
        ownerId: lease.ownerId,
        ownerEpoch: lease.epoch,
        callbackFence: createSessionControlCallbackFence({
            runtime,
            lease,
            operationId,
            nowWallMs: () => 1_200,
        }),
    };
    return {
        runtime,
        lease,
        epoch,
        createOperation: (jobId: string) =>
            createSessionControlOperation({
                runtime,
                lease,
                operationId,
                barrierKind: 'all_mutations',
                deadlineWallMs: 20_000,
                capturedHandleIds: [`job:${jobId}`],
                nowWallMs: 1_100,
            }),
        operation: () => readSessionControlOperation(runtime, lease.dbIdentity, lease.sessionId, operationId),
    };
}

function rejectingMirror(): {
    readonly value: AsyncJobPersistenceMirror;
    readonly durableWrites: () => number;
} {
    let durableWrites = 0;
    return {
        value: {
            recordJob: (handle, client) => {
                if (client !== undefined && handle.status !== 'queued' && handle.status !== 'running') {
                    throw new Error('mirror rejected');
                }
                if (client !== undefined) durableWrites += 1;
            },
        },
        durableWrites: () => durableWrites,
    };
}
