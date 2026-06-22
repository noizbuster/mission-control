import { describe, expect, it } from 'vitest';
import type { JobExecuteFn } from './async-job-manager.js';
import { AsyncJobManager } from './async-job-manager.js';

type JobResult = { status: 'completed' | 'failed'; output: string };

interface ControllableExecute {
    readonly execute: JobExecuteFn;
    readonly complete: (output: string) => void;
    readonly fail: (message: string) => void;
    readonly capturedSignal: () => AbortSignal | undefined;
}

/**
 * Returns an execute function whose promise settles only when complete/fail is
 * called. The function also rejects on abort so cancellation fully propagates
 * through the promise chain (triggering .finally cleanup).
 */
function makeControllableExecute(): ControllableExecute {
    const resolvers: Array<(result: JobResult) => void> = [];
    let signal: AbortSignal | undefined;
    return {
        execute: (sig: AbortSignal): Promise<JobResult> => {
            signal = sig;
            return new Promise<JobResult>((resolve, reject) => {
                resolvers.push(resolve);
                sig.addEventListener('abort', () => reject(new Error('aborted')), {
                    once: true,
                });
            });
        },
        complete: (output: string): void => {
            const r = resolvers.shift();
            if (r !== undefined) r({ status: 'completed', output });
        },
        fail: (message: string): void => {
            const r = resolvers.shift();
            if (r !== undefined) r({ status: 'failed', output: message });
        },
        capturedSignal: (): AbortSignal | undefined => signal,
    };
}

function makeImmediateExecute(output: string): JobExecuteFn {
    return async () => ({ status: 'completed' as const, output });
}

function makeFailingExecute(output: string): JobExecuteFn {
    return async () => ({ status: 'failed' as const, output });
}

function makeThrowingExecute(message: string): JobExecuteFn {
    return async () => {
        throw new Error(message);
    };
}

/** Flushes microtask + timer queues so promise chains fully settle. */
function flush(): Promise<void> {
    return new Promise<void>((resolve) => {
        setTimeout(() => resolve(), 0);
    });
}

describe('AsyncJobManager', () => {
    describe('(a) semaphore with maxConcurrency', () => {
        it('runs up to maxConcurrency jobs and queues the rest', () => {
            const manager = new AsyncJobManager(2);
            const a = makeControllableExecute();
            const b = makeControllableExecute();
            const c = makeControllableExecute();

            const h1 = manager.startJob({ sessionId: 's1', execute: a.execute });
            const h2 = manager.startJob({ sessionId: 's2', execute: b.execute });
            const h3 = manager.startJob({ sessionId: 's3', execute: c.execute });

            expect(h1.status).toBe('running');
            expect(h2.status).toBe('running');
            expect(h3.status).toBe('queued');
            expect(manager.getActiveCount()).toBe(2);
        });

        it('starts a queued job when a running job completes', async () => {
            const manager = new AsyncJobManager(2);
            const a = makeControllableExecute();
            const b = makeControllableExecute();
            const c = makeControllableExecute();

            manager.startJob({ sessionId: 's1', execute: a.execute });
            manager.startJob({ sessionId: 's2', execute: b.execute });
            const h3 = manager.startJob({ sessionId: 's3', execute: c.execute });

            expect(h3.status).toBe('queued');

            a.complete('done');
            await flush();

            expect(h3.status).toBe('running');
            expect(manager.getActiveCount()).toBe(2);
        });

        it('defaults maxConcurrency to 4', () => {
            const manager = new AsyncJobManager();
            const ctrls = [
                makeControllableExecute(),
                makeControllableExecute(),
                makeControllableExecute(),
                makeControllableExecute(),
                makeControllableExecute(),
            ];
            for (const [i, ctrl] of ctrls.entries()) {
                manager.startJob({ sessionId: `s${i}`, execute: ctrl.execute });
            }

            expect(manager.getActiveCount()).toBe(4);
        });
    });

    describe('(b) cancelJob', () => {
        it('sets status to cancelled for a running job', () => {
            const manager = new AsyncJobManager(2);
            const ctrl = makeControllableExecute();
            const handle = manager.startJob({ sessionId: 's1', execute: ctrl.execute });

            expect(handle.status).toBe('running');

            manager.cancelJob(handle.jobId);

            expect(handle.status).toBe('cancelled');
        });

        it('propagates the abort signal to the execute function', () => {
            const manager = new AsyncJobManager(2);
            const ctrl = makeControllableExecute();
            const handle = manager.startJob({ sessionId: 's1', execute: ctrl.execute });

            const signal = ctrl.capturedSignal();
            if (signal === undefined) throw new Error('execute was not called');
            expect(signal.aborted).toBe(false);

            manager.cancelJob(handle.jobId);

            expect(signal.aborted).toBe(true);
        });

        it('sets status to cancelled for a queued job', () => {
            const manager = new AsyncJobManager(1);
            const a = makeControllableExecute();
            const b = makeControllableExecute();

            manager.startJob({ sessionId: 's1', execute: a.execute });
            const h2 = manager.startJob({ sessionId: 's2', execute: b.execute });

            expect(h2.status).toBe('queued');

            manager.cancelJob(h2.jobId);

            expect(h2.status).toBe('cancelled');
        });

        it('is a no-op on an unknown job id', () => {
            const manager = new AsyncJobManager(2);
            expect(() => manager.cancelJob('job-nonexistent')).not.toThrow();
        });

        it('is a no-op on an already-completed job', async () => {
            const manager = new AsyncJobManager(2);
            const handle = manager.startJob({
                sessionId: 's1',
                execute: makeImmediateExecute('done'),
            });
            await flush();
            expect(handle.status).toBe('completed');

            manager.cancelJob(handle.jobId);

            expect(handle.status).toBe('completed');
        });

        it('cancels the job when an externally-provided signal aborts', async () => {
            const manager = new AsyncJobManager(2);
            const external = new AbortController();
            const handle = manager.startJob({
                sessionId: 's1',
                execute: makeControllableExecute().execute,
                signal: external.signal,
            });

            expect(handle.status).toBe('running');

            external.abort();
            await flush();

            expect(handle.status).toBe('cancelled');
        });

        it('cancels immediately when the provided signal is already aborted', () => {
            const manager = new AsyncJobManager(2);
            const alreadyAborted = AbortSignal.abort();

            const handle = manager.startJob({
                sessionId: 's1',
                execute: makeImmediateExecute('never runs'),
                signal: alreadyAborted,
            });

            expect(handle.status).toBe('cancelled');
        });
    });

    describe('(c) awaitJob', () => {
        it('returns the handle with result when the job completes', async () => {
            const manager = new AsyncJobManager(2);
            const ctrl = makeControllableExecute();
            const handle = manager.startJob({ sessionId: 's1', execute: ctrl.execute });

            const awaitPromise = manager.awaitJob(handle.jobId);
            ctrl.complete('job output');
            const settled = await awaitPromise;

            expect(settled.status).toBe('completed');
            expect(settled.result).toEqual({ status: 'completed', output: 'job output' });
        });

        it('returns the handle with result when the job fails via execute return', async () => {
            const manager = new AsyncJobManager(2);
            const ctrl = makeControllableExecute();
            const handle = manager.startJob({ sessionId: 's1', execute: ctrl.execute });

            const awaitPromise = manager.awaitJob(handle.jobId);
            ctrl.fail('something went wrong');
            const settled = await awaitPromise;

            expect(settled.status).toBe('failed');
            expect(settled.result).toEqual({ status: 'failed', output: 'something went wrong' });
        });

        it('returns the handle with error when execute throws', async () => {
            const manager = new AsyncJobManager(2);
            const handle = manager.startJob({
                sessionId: 's1',
                execute: makeThrowingExecute('crash'),
            });

            const settled = await manager.awaitJob(handle.jobId);

            expect(settled.status).toBe('failed');
            expect(settled.error).toBe('crash');
        });

        it('returns immediately for an already-completed job', async () => {
            const manager = new AsyncJobManager(2);
            const handle = manager.startJob({
                sessionId: 's1',
                execute: makeImmediateExecute('done'),
            });
            await flush();

            const settled = await manager.awaitJob(handle.jobId);

            expect(settled.status).toBe('completed');
        });

        it('resolves with cancelled status when a queued job is cancelled', async () => {
            const manager = new AsyncJobManager(1);
            const a = makeControllableExecute();
            const b = makeControllableExecute();

            manager.startJob({ sessionId: 's1', execute: a.execute });
            const h2 = manager.startJob({ sessionId: 's2', execute: b.execute });

            const awaitPromise = manager.awaitJob(h2.jobId);
            manager.cancelJob(h2.jobId);
            const settled = await awaitPromise;

            expect(settled.status).toBe('cancelled');
        });

        it('throws for an unknown job id', async () => {
            const manager = new AsyncJobManager(2);
            await expect(manager.awaitJob('job-nonexistent')).rejects.toThrow(/unknown job/);
        });
    });

    describe('(d) getActiveCount', () => {
        it('reflects running jobs only, not queued', () => {
            const manager = new AsyncJobManager(2);
            manager.startJob({ sessionId: 's1', execute: makeControllableExecute().execute });
            manager.startJob({ sessionId: 's2', execute: makeControllableExecute().execute });
            manager.startJob({ sessionId: 's3', execute: makeControllableExecute().execute });

            expect(manager.getActiveCount()).toBe(2);
        });

        it('decrements when a job completes', async () => {
            const manager = new AsyncJobManager(2);
            const ctrl = makeControllableExecute();
            manager.startJob({ sessionId: 's1', execute: ctrl.execute });

            expect(manager.getActiveCount()).toBe(1);

            ctrl.complete('done');
            await flush();

            expect(manager.getActiveCount()).toBe(0);
        });

        it('decrements when a running job is cancelled', async () => {
            const manager = new AsyncJobManager(2);
            const ctrl = makeControllableExecute();
            const handle = manager.startJob({ sessionId: 's1', execute: ctrl.execute });

            expect(manager.getActiveCount()).toBe(1);

            manager.cancelJob(handle.jobId);
            await flush();

            expect(manager.getActiveCount()).toBe(0);
        });

        it('does not count queued jobs even when they are cancelled', () => {
            const manager = new AsyncJobManager(1);
            manager.startJob({ sessionId: 's1', execute: makeControllableExecute().execute });
            const h2 = manager.startJob({ sessionId: 's2', execute: makeControllableExecute().execute });

            expect(h2.status).toBe('queued');
            expect(manager.getActiveCount()).toBe(1);

            manager.cancelJob(h2.jobId);

            expect(manager.getActiveCount()).toBe(1);
        });
    });

    describe('(e) listJobs', () => {
        it('returns all handles across completed, cancelled, and failed', async () => {
            const manager = new AsyncJobManager(1);
            const ctrlA = makeControllableExecute();
            const ctrlB = makeControllableExecute();

            // Job 1: running (holds the only slot)
            const hRunning = manager.startJob({ sessionId: 's-run', execute: ctrlA.execute });
            expect(hRunning.status).toBe('running');

            // Job 2: queued
            const hQueued = manager.startJob({ sessionId: 's-q', execute: ctrlB.execute });
            expect(hQueued.status).toBe('queued');

            // Cancel the queued job
            manager.cancelJob(hQueued.jobId);
            expect(hQueued.status).toBe('cancelled');

            // Complete the running job
            ctrlA.complete('done');
            await flush();
            expect(hRunning.status).toBe('completed');

            // Start a job that fails via execute return
            const hFailed = manager.startJob({
                sessionId: 's-fail',
                execute: makeFailingExecute('boom'),
            });
            await flush();
            expect(hFailed.status).toBe('failed');

            const all = manager.listJobs();
            expect(all).toHaveLength(3);

            const statusById = new Map(all.map((h) => [h.jobId, h.status] as const));
            expect(statusById.get(hRunning.jobId)).toBe('completed');
            expect(statusById.get(hQueued.jobId)).toBe('cancelled');
            expect(statusById.get(hFailed.jobId)).toBe('failed');
        });

        it('includes running and queued jobs alongside terminal ones', () => {
            const manager = new AsyncJobManager(2);
            const a = makeControllableExecute();
            const b = makeControllableExecute();
            const c = makeControllableExecute();

            const h1 = manager.startJob({ sessionId: 's1', execute: a.execute });
            const h2 = manager.startJob({ sessionId: 's2', execute: b.execute });
            const h3 = manager.startJob({ sessionId: 's3', execute: c.execute });

            const all = manager.listJobs();
            expect(all).toHaveLength(3);

            const byId = new Map(all.map((h) => [h.jobId, h.status] as const));
            expect(byId.get(h1.jobId)).toBe('running');
            expect(byId.get(h2.jobId)).toBe('running');
            expect(byId.get(h3.jobId)).toBe('queued');
        });

        it('returns an empty array when no jobs exist', () => {
            const manager = new AsyncJobManager(2);
            expect(manager.listJobs()).toEqual([]);
        });

        it('returns readonly handles (callers see live status mutations)', async () => {
            const manager = new AsyncJobManager(2);
            const ctrl = makeControllableExecute();
            const handle = manager.startJob({ sessionId: 's1', execute: ctrl.execute });

            const snapshot = manager.listJobs();
            expect(snapshot).toHaveLength(1);
            expect(snapshot[0]?.status).toBe('running');

            ctrl.complete('done');
            await flush();

            // Same array, but the handle's status mutated internally
            expect(snapshot[0]?.status).toBe('completed');
            expect(handle.status).toBe('completed');
        });
    });
});
