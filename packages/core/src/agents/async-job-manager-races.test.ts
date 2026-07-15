import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncJobCleanupError, AsyncJobManager, QuarantinedJobSettlementError } from './async-job-manager';
import {
    abortListenerCounts,
    cleanupLifecycleHosts,
    createLifecycleHost,
} from './task-tool-runtime-lifecycle-test-support';

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupLifecycleHosts();
});

describe('AsyncJobManager preparation races', () => {
    it('detaches a late attachment after stale cancellation without recording or starting it', async () => {
        const fixture = await createLifecycleHost('job-stale-cancel-late-attach');
        const attached = deferred<{ readonly detach: () => Promise<void> }>();
        const detach = vi.fn(async () => undefined);
        vi.spyOn(fixture.host, 'attachEntity').mockReturnValue(attached.promise);
        const recordJob = vi.fn();
        const manager = new AsyncJobManager(1, {
            sessionControlHost: fixture.host,
            mirror: { recordJob },
        });
        const execute = vi.fn(async () => ({ status: 'completed' as const, output: 'must not run' }));
        const handle = manager.startJob({
            sessionId: 'stale-child',
            parentSessionId: 'parent-session',
            controlEpoch: controlEpoch('stale-late-attach', async () => ({ accepted: false, allSettled: false })),
            execute,
        });

        manager.cancelJob(handle.jobId, 'operator_aborted');
        await new Promise<void>((resolve) => setImmediate(resolve));
        attached.resolve({ detach });
        await manager.drainPreparations();

        await expect(manager.awaitJob(handle.jobId)).rejects.toBeInstanceOf(QuarantinedJobSettlementError);
        expect(recordJob).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        expect(detach).toHaveBeenCalledTimes(1);
    });

    it('settles repeated controlled cancellation once while attachment is pending', async () => {
        const fixture = await createLifecycleHost('job-repeated-pending-cancel');
        const attached = deferred<{ readonly detach: () => Promise<void> }>();
        const settlement = deferred<{ readonly accepted: true; readonly allSettled: true }>();
        const detach = vi.fn(async () => undefined);
        vi.spyOn(fixture.host, 'attachEntity').mockReturnValue(attached.promise);
        const settle = vi.fn(() => settlement.promise);
        const onTerminatedBeforeStart = vi.fn();
        const manager = new AsyncJobManager(1, {
            sessionControlHost: fixture.host,
            mirror: { recordJob: () => undefined },
        });
        const handle = manager.startJob({
            sessionId: 'queued-child',
            parentSessionId: 'parent-session',
            controlEpoch: controlEpoch('repeated-pending-cancel', settle),
            onTerminatedBeforeStart,
            execute: async () => ({ status: 'completed', output: 'must not run' }),
        });

        manager.cancelJob(handle.jobId, 'operator_aborted');
        manager.cancelJob(handle.jobId, 'operator_aborted');
        attached.resolve({ detach });
        await manager.drainPreparations();

        expect(settle).toHaveBeenCalledTimes(1);
        settlement.resolve({ accepted: true, allSettled: true });
        const settled = await manager.awaitJob(handle.jobId);
        expect(settled.status).toBe('cancelled');
        expect(onTerminatedBeforeStart).toHaveBeenCalledTimes(1);
        expect(detach).toHaveBeenCalledTimes(1);
    });

    it('preserves execution failure when controlled settlement has no mirror', async () => {
        const executionError = new Error('execution rejected');
        const manager = new AsyncJobManager(1);
        const handle = manager.startJob({
            sessionId: 'missing-mirror-child',
            controlEpoch: controlEpoch('missing-mirror', async () => ({ accepted: true, allSettled: true })),
            execute: async () => Promise.reject(executionError),
        });

        const failure = await manager.awaitJob(handle.jobId).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AsyncJobCleanupError);
        if (failure instanceof AsyncJobCleanupError) {
            expect(failure.primaryError).toBe(executionError);
            expect(failure.suppressedErrors).toHaveLength(1);
            expect(failure.suppressedErrors[0]).toMatchObject({
                message: 'controlled job persistence mirror is required',
            });
        }
    });

    it('returns accepted external cancellation when late attachment rejects and notifies once', async () => {
        const fixture = await createLifecycleHost('job-cancel-late-attach-reject');
        const attached = deferred<{ readonly detach: () => Promise<void> }>();
        vi.spyOn(fixture.host, 'attachEntity').mockReturnValue(attached.promise);
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const onTerminatedBeforeStart = vi.fn();
        const manager = new AsyncJobManager(1, { sessionControlHost: fixture.host });
        const handle = manager.startJob({
            sessionId: 'cancelled-child',
            parentSessionId: 'parent-session',
            onTerminatedBeforeStart,
            signal: controller.signal,
            execute: async () => ({ status: 'completed', output: 'must not run' }),
        });
        const attachError = new Error('late attachment rejected');

        controller.abort();
        attached.reject(attachError);
        const settled = await manager.awaitJob(handle.jobId);

        expect(settled).toBe(handle);
        expect(settled.status).toBe('cancelled');
        expect(onTerminatedBeforeStart).toHaveBeenCalledTimes(1);
        expect(counts()).toEqual({ added: 1, removed: 1 });
    });

    it('records an unfenced attachment failure as a terminal mirror snapshot', async () => {
        const fixture = await createLifecycleHost('job-attach-failure-terminal-mirror');
        const attachError = new Error('attach rejected');
        vi.spyOn(fixture.host, 'attachEntity').mockRejectedValue(attachError);
        const statuses: string[] = [];
        const manager = new AsyncJobManager(1, {
            sessionControlHost: fixture.host,
            mirror: {
                recordJob: (handle) => {
                    statuses.push(handle.status);
                },
            },
        });
        const handle = manager.startJob({
            sessionId: 'failed-child',
            parentSessionId: 'parent-session',
            execute: async () => ({ status: 'completed', output: 'must not run' }),
        });

        const settled = await manager.awaitJob(handle.jobId);

        expect(settled.status).toBe('failed');
        expect(settled.error).toBe(attachError.message);
        expect(statuses).toEqual(['failed']);
    });

    it('preserves attachment and queued-cancellation fence failures together', async () => {
        const fixture = await createLifecycleHost('job-attach-and-fence-reject');
        const attached = deferred<{ readonly detach: () => Promise<void> }>();
        const settlement = deferred<{ readonly accepted: true; readonly allSettled: true }>();
        vi.spyOn(fixture.host, 'attachEntity').mockReturnValue(attached.promise);
        const controller = new AbortController();
        const attachError = new Error('attach rejected');
        const fenceError = new Error('fence rejected');
        const settle = vi.fn(() => settlement.promise);
        const manager = new AsyncJobManager(1, {
            sessionControlHost: fixture.host,
            mirror: { recordJob: () => undefined },
        });
        const handle = manager.startJob({
            sessionId: 'failed-child',
            parentSessionId: 'parent-session',
            signal: controller.signal,
            controlEpoch: controlEpoch('attach-and-fence-reject', settle),
            execute: async () => ({ status: 'completed', output: 'must not run' }),
        });

        controller.abort();
        attached.reject(attachError);
        await vi.waitFor(() => expect(settle).toHaveBeenCalledTimes(1));
        settlement.reject(fenceError);
        const failure = await manager.awaitJob(handle.jobId).catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(AsyncJobCleanupError);
        if (failure instanceof AsyncJobCleanupError) {
            expect(failure.primaryError).toBe(attachError);
            expect(failure.suppressedErrors).toContain(fenceError);
        }
    });

    it('passes immutable lifecycle snapshots to asynchronous mirror observers', async () => {
        const execution = deferred<{ readonly status: 'completed'; readonly output: string }>();
        const snapshots: Array<{ readonly status: string }> = [];
        const manager = new AsyncJobManager(1, {
            mirror: {
                recordJob: (handle) => {
                    snapshots.push(handle);
                },
            },
        });
        const handle = manager.startJob({
            sessionId: 'snapshot-child',
            execute: () => execution.promise,
        });

        execution.resolve({ status: 'completed', output: 'done' });
        await manager.awaitJob(handle.jobId);

        expect(snapshots.map((snapshot) => snapshot.status)).toEqual(['queued', 'running', 'completed']);
    });
});

function controlEpoch(
    operationId: string,
    settle: NonNullable<
        NonNullable<Parameters<AsyncJobManager['startJob']>[0]['controlEpoch']>['callbackFence']
    >['settle'],
) {
    return {
        dbIdentity: '7'.repeat(64),
        sessionId: 'parent-session',
        ownerId: 'owner',
        ownerEpoch: 1,
        callbackFence: { operationId, settle },
    };
}

function deferred<T>(): {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
    readonly reject: (reason: unknown) => void;
} {
    let resolvePromise: (value: T) => void = () => undefined;
    let rejectPromise: (reason: unknown) => void = () => undefined;
    const promise = new Promise<T>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return { promise, resolve: resolvePromise, reject: rejectPromise };
}
