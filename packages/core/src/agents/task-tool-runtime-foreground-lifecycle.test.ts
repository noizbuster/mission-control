import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChildSessionCancelledError, ChildSessionCleanupError } from './task-tool-runtime-control';
import {
    abortListenerCounts,
    buildLifecycleRuntime,
    cleanupLifecycleHosts,
    createLifecycleHost,
    lifecycleRequest,
    makeLifecycleServices,
    resolvingMirror,
} from './task-tool-runtime-lifecycle-test-support';

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupLifecycleHosts();
});

describe('foreground child control lifecycle', () => {
    it('removes the listener and skips adoption when foreground child attachment rejects', async () => {
        const fixture = await createLifecycleHost('foreground-attach-reject');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const attachError = new Error('attach rejected');
        vi.spyOn(fixture.host, 'attachEntity').mockRejectedValue(attachError);
        const services = makeLifecycleServices({ host: fixture.host });
        const spawn = vi.fn(async () => ({
            sessionId: fixture.sessionId,
            status: 'completed' as const,
            output: 'late',
        }));
        const runtime = buildLifecycleRuntime(services, spawn);

        await expect(runtime.runChildSession(lifecycleRequest(fixture.sessionId, controller.signal))).rejects.toBe(
            attachError,
        );

        expect(spawn).not.toHaveBeenCalled();
        expect(services.runtimeRegistry.lookup(fixture.sessionId)).toBeUndefined();
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('does not spawn when foreground cancellation arrives during child attachment', async () => {
        const fixture = await createLifecycleHost('foreground-cancel-during-attach');
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
        const running = runtime.runChildSession(lifecycleRequest(fixture.sessionId, controller.signal));

        controller.abort();
        finishAttach?.();

        await expect(running).rejects.toBeInstanceOf(ChildSessionCancelledError);
        expect(spawn).not.toHaveBeenCalled();
        expect(services.runtimeRegistry.lookup(fixture.sessionId)).toBeUndefined();
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('settles without spawning when cancellation arrives during mirror start', async () => {
        const fixture = await createLifecycleHost('foreground-cancel-during-mirror-start');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        let finishMirrorStart: (() => void) | undefined;
        let markMirrorStarted: (() => void) | undefined;
        const mirrorStarted = new Promise<void>((resolve) => {
            markMirrorStarted = resolve;
        });
        const services = makeLifecycleServices({
            host: fixture.host,
            mirror: resolvingMirror({
                startSubagentWait: async () => {
                    markMirrorStarted?.();
                    await new Promise<void>((resolve) => {
                        finishMirrorStart = resolve;
                    });
                },
            }),
        });
        const spawn = vi.fn(async () => ({
            sessionId: fixture.sessionId,
            status: 'completed' as const,
            output: 'must not run',
        }));
        const runtime = buildLifecycleRuntime(services, spawn);
        const running = runtime.runChildSession(lifecycleRequest(fixture.sessionId, controller.signal));
        await mirrorStarted;

        controller.abort();
        finishMirrorStart?.();

        await expect(running).rejects.toBeInstanceOf(ChildSessionCancelledError);
        expect(spawn).not.toHaveBeenCalled();
        expect(services.runtimeRegistry.lookup(fixture.sessionId)?.status).toBe('aborted');
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('quiesces the host and listener after success', async () => {
        const fixture = await createLifecycleHost('foreground-success');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const runtime = buildLifecycleRuntime(makeLifecycleServices({ host: fixture.host }), async (context) => ({
            sessionId: context.sessionId,
            status: 'completed',
            output: 'done',
        }));

        await runtime.runChildSession(lifecycleRequest(fixture.sessionId, controller.signal));

        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('quiesces after spawn rejection and returns a structured terminal failure', async () => {
        const fixture = await createLifecycleHost('foreground-spawn-reject');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const spawnError = new Error('spawn rejected');
        const services = makeLifecycleServices({ host: fixture.host, mirror: resolvingMirror() });
        const runtime = buildLifecycleRuntime(services, async () => Promise.reject(spawnError));

        const result = await runtime.runChildSession(lifecycleRequest(fixture.sessionId, controller.signal));

        expect(result).toMatchObject({
            sessionId: fixture.sessionId,
            status: 'failed',
            failure: { code: 'task_child_failed', retryable: false },
        });
        expect(services.runtimeRegistry.lookup(fixture.sessionId)?.status).toBe('aborted');
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('preserves a provider terminal failure when child-control cleanup rejects', async () => {
        const fixture = await createLifecycleHost('foreground-provider-cleanup-reject');
        const detachError = new Error('child detach rejected');
        const originalAttach = fixture.host.attachEntity.bind(fixture.host);
        vi.spyOn(fixture.host, 'attachEntity').mockImplementation(async (input) => {
            const attachment = await originalAttach(input);
            return {
                detach: async () => {
                    await attachment.detach();
                    throw detachError;
                },
            };
        });
        const runtime = buildLifecycleRuntime(makeLifecycleServices({ host: fixture.host }), async (context) => ({
            sessionId: context.sessionId,
            status: 'failed',
            output: '[degraded salvage] partial child output',
            failureKind: 'graph_failed',
            failure: {
                code: 'provider_aborted',
                message: 'remote provider closed the child stream',
                retryable: false,
            },
        }));

        const result = await runtime.runChildSession(lifecycleRequest(fixture.sessionId));

        expect(result).toMatchObject({
            status: 'failed',
            failure: {
                code: 'provider_aborted',
                message: 'remote provider closed the child stream',
                retryable: false,
            },
        });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('quiesces when registry adoption rejects before spawn', async () => {
        const fixture = await createLifecycleHost('foreground-adopt-reject');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const services = makeLifecycleServices({ host: fixture.host });
        const adoptionError = new Error('adoption rejected');
        vi.spyOn(services.runtimeRegistry, 'adopt').mockImplementation(() => {
            throw adoptionError;
        });
        const spawn = vi.fn(async () => ({
            sessionId: fixture.sessionId,
            status: 'completed' as const,
            output: 'late',
        }));
        const runtime = buildLifecycleRuntime(services, spawn);

        await expect(runtime.runChildSession(lifecycleRequest(fixture.sessionId, controller.signal))).rejects.toBe(
            adoptionError,
        );

        expect(spawn).not.toHaveBeenCalled();
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('settles only the adopted registry ref when foreground mirror start rejects', async () => {
        const fixture = await createLifecycleHost('foreground-mirror-start-reject');
        const mirrorError = new Error('mirror start rejected');
        const mirror = resolvingMirror({ startSubagentWait: async () => Promise.reject(mirrorError) });
        const services = makeLifecycleServices({ host: fixture.host, mirror });
        const spawn = vi.fn(async () => ({
            sessionId: fixture.sessionId,
            status: 'completed' as const,
            output: 'late',
        }));
        const runtime = buildLifecycleRuntime(services, spawn);

        await expect(runtime.runChildSession(lifecycleRequest(fixture.sessionId))).rejects.toBe(mirrorError);

        expect(spawn).not.toHaveBeenCalled();
        expect(services.runtimeRegistry.lookup(fixture.sessionId)?.status).toBe('aborted');
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('surfaces mirror settlement rejection and still quiesces the host', async () => {
        const fixture = await createLifecycleHost('foreground-settle-reject');
        const settleError = new Error('mirror settlement rejected');
        const mirror = resolvingMirror({ resolveSubagentWait: async () => Promise.reject(settleError) });
        const services = makeLifecycleServices({ host: fixture.host, mirror });
        const runtime = buildLifecycleRuntime(services, async (context) => ({
            sessionId: context.sessionId,
            status: 'completed',
            output: 'done',
        }));

        await expect(runtime.runChildSession(lifecycleRequest(fixture.sessionId))).rejects.toBe(settleError);

        expect(services.runtimeRegistry.lookup(fixture.sessionId)?.status).toBe('running');
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('preserves spawn failure as typed primary context when settlement and detach also reject', async () => {
        const fixture = await createLifecycleHost('foreground-dual-failure');
        const spawnError = new Error('spawn rejected');
        const settlementError = new Error('settlement rejected');
        const detachError = new Error('detach rejected');
        const originalAttach = fixture.host.attachEntity.bind(fixture.host);
        vi.spyOn(fixture.host, 'attachEntity').mockImplementation(async (input) => {
            const attachment = await originalAttach(input);
            return {
                detach: async () => {
                    await attachment.detach();
                    throw detachError;
                },
            };
        });
        const mirror = resolvingMirror({ resolveSubagentWait: async () => Promise.reject(settlementError) });
        const runtime = buildLifecycleRuntime(makeLifecycleServices({ host: fixture.host, mirror }), async () =>
            Promise.reject(spawnError),
        );

        const failure = await runtime
            .runChildSession(lifecycleRequest(fixture.sessionId))
            .catch((error: unknown) => error);

        expect(failure).toBeInstanceOf(ChildSessionCleanupError);
        if (failure instanceof ChildSessionCleanupError) {
            expect(failure.primaryError).toBe(spawnError);
            expect(failure.suppressedErrors).toEqual([settlementError, detachError]);
        }
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('forwards upstream abort and quiesces after cancellation', async () => {
        const fixture = await createLifecycleHost('foreground-abort');
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        let started: (() => void) | undefined;
        const spawnStarted = new Promise<void>((resolve) => {
            started = resolve;
        });
        const runtime = buildLifecycleRuntime(makeLifecycleServices({ host: fixture.host }), (context) => {
            started?.();
            return new Promise((resolve) => {
                context.signal.addEventListener(
                    'abort',
                    () => resolve({ sessionId: context.sessionId, status: 'failed', output: 'aborted' }),
                    { once: true },
                );
            });
        });
        const running = runtime.runChildSession(lifecycleRequest(fixture.sessionId, controller.signal));
        await spawnStarted;

        controller.abort();
        const result = await running;

        expect(result.status).toBe('failed');
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });
});
