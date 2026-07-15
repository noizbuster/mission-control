import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    abortListenerCounts,
    buildLifecycleRuntime,
    cleanupLifecycleHosts,
    createLifecycleHost,
    lifecycleRequest,
    makeLifecycleServices,
} from './task-tool-runtime-lifecycle-test-support.js';

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupLifecycleHosts();
});

describe('background child control lifecycle', () => {
    it('quiesces the host after success', async () => {
        const fixture = await createLifecycleHost('background-success');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const services = makeLifecycleServices({ host: fixture.host });
        const runtime = buildLifecycleRuntime(services, async (context) => ({
            sessionId: context.sessionId,
            status: 'completed',
            output: 'done',
        }));

        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId, controller.signal));
        const settled = await services.jobManager.awaitJob(handle.backgroundId);

        expect(settled.status).toBe('completed');
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('quiesces when background child attachment rejects before spawn', async () => {
        const fixture = await createLifecycleHost('background-attach-reject');
        const attachError = new Error('attach rejected');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        vi.spyOn(fixture.host, 'attachEntity').mockRejectedValue(attachError);
        const services = makeLifecycleServices({ host: fixture.host });
        const spawn = vi.fn(async () => ({
            sessionId: fixture.sessionId,
            status: 'completed' as const,
            output: 'late',
        }));
        const runtime = buildLifecycleRuntime(services, spawn);

        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId, controller.signal));
        const settled = await services.jobManager.awaitJob(handle.backgroundId);

        expect(settled.status).toBe('failed');
        expect(settled.error).toBe(attachError.message);
        expect(spawn).not.toHaveBeenCalled();
        expect(services.runtimeRegistry.lookup(fixture.sessionId)?.status).toBe('aborted');
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('does not spawn when background cancellation arrives during child attachment', async () => {
        const fixture = await createLifecycleHost('background-cancel-during-attach');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const originalAttach = fixture.host.attachEntity.bind(fixture.host);
        let finishAttach: (() => void) | undefined;
        vi.spyOn(fixture.host, 'attachEntity').mockImplementation(
            (input) =>
                new Promise((resolve, reject) => {
                    finishAttach = () => {
                        void originalAttach(input).then(resolve, reject);
                    };
                }),
        );
        const services = makeLifecycleServices({ host: fixture.host });
        const spawn = vi.fn(async () => ({
            sessionId: fixture.sessionId,
            status: 'completed' as const,
            output: 'must not run',
        }));
        const runtime = buildLifecycleRuntime(services, spawn);
        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId, controller.signal));

        controller.abort();
        finishAttach?.();
        const settled = await services.jobManager.awaitJob(handle.backgroundId);

        expect(settled.status).toBe('cancelled');
        expect(spawn).not.toHaveBeenCalled();
        expect(services.runtimeRegistry.lookup(fixture.sessionId)?.status).toBe('aborted');
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('quiesces after background spawn rejection and preserves the spawn error', async () => {
        const fixture = await createLifecycleHost('background-spawn-reject');
        const spawnError = new Error('spawn rejected');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const services = makeLifecycleServices({ host: fixture.host });
        const runtime = buildLifecycleRuntime(services, async () => Promise.reject(spawnError));

        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId, controller.signal));
        const settled = await services.jobManager.awaitJob(handle.backgroundId);

        expect(settled.status).toBe('failed');
        expect(settled.error).toBe(spawnError.message);
        expect(services.runtimeRegistry.lookup(fixture.sessionId)?.status).toBe('aborted');
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('does not attach control when background adoption rejects synchronously', async () => {
        const fixture = await createLifecycleHost('background-adopt-reject');
        const services = makeLifecycleServices({ host: fixture.host });
        const adoptionError = new Error('adoption rejected');
        vi.spyOn(services.runtimeRegistry, 'adopt').mockImplementation(() => {
            throw adoptionError;
        });
        const runtime = buildLifecycleRuntime(services, async (context) => ({
            sessionId: context.sessionId,
            status: 'completed',
            output: 'late',
        }));

        expect(() => runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId))).toThrow(adoptionError);

        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('settles an adopted ref and removes its listener when a queued background child is cancelled', async () => {
        const runningFixture = await createLifecycleHost('background-running-before-queue');
        const queuedFixture = await createLifecycleHost('background-queued-cancel');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        let releaseRunning: (() => void) | undefined;
        let markRunningStarted: (() => void) | undefined;
        const runningStarted = new Promise<void>((resolve) => {
            markRunningStarted = resolve;
        });
        const services = makeLifecycleServices({ host: queuedFixture.host, maxConcurrency: 1 });
        const runtime = buildLifecycleRuntime(services, (context) => {
            if (context.sessionId === runningFixture.sessionId) {
                return new Promise((resolve) => {
                    releaseRunning = () =>
                        resolve({ sessionId: context.sessionId, status: 'completed', output: 'released' });
                    markRunningStarted?.();
                });
            }
            return Promise.resolve({ sessionId: context.sessionId, status: 'completed', output: 'unexpected' });
        });
        const running = runtime.startBackgroundSession(lifecycleRequest(runningFixture.sessionId));
        const queued = runtime.startBackgroundSession(lifecycleRequest(queuedFixture.sessionId, controller.signal));
        await runningStarted;

        services.jobManager.cancelJob(queued.backgroundId);
        const settled = await services.jobManager.awaitJob(queued.backgroundId);
        releaseRunning?.();
        await services.jobManager.awaitJob(running.backgroundId);

        expect(settled.status).toBe('cancelled');
        expect(services.runtimeRegistry.lookup(queuedFixture.sessionId)?.status).toBe('aborted');
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(queuedFixture.host.classify(queuedFixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('forwards upstream abort and quiesces after background cancellation', async () => {
        const fixture = await createLifecycleHost('background-abort');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const originalAttach = fixture.host.attachEntity.bind(fixture.host);
        let childDetachCalls = 0;
        vi.spyOn(fixture.host, 'attachEntity').mockImplementation(async (input) => {
            const attachment = await originalAttach(input);
            return {
                detach: async () => {
                    childDetachCalls += 1;
                    await attachment.detach();
                },
            };
        });
        const services = makeLifecycleServices({ host: fixture.host });
        let started: (() => void) | undefined;
        const spawnStarted = new Promise<void>((resolve) => {
            started = resolve;
        });
        const runtime = buildLifecycleRuntime(services, (context) => {
            started?.();
            return new Promise((resolve) => {
                context.signal.addEventListener(
                    'abort',
                    () => resolve({ sessionId: context.sessionId, status: 'failed', output: 'aborted' }),
                    { once: true },
                );
            });
        });
        const handle = runtime.startBackgroundSession(lifecycleRequest(fixture.sessionId, controller.signal));
        await spawnStarted;

        controller.abort();
        controller.abort();
        services.jobManager.cancelJob(handle.backgroundId);
        services.jobManager.cancelJob(handle.backgroundId);
        const settled = await services.jobManager.awaitJob(handle.backgroundId);
        await services.jobManager.drain();

        expect(settled.status).toBe('cancelled');
        expect(childDetachCalls).toBe(1);
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });
});
