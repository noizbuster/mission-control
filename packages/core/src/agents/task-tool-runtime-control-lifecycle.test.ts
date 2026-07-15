import { afterEach, describe, expect, it, vi } from 'vitest';
import { attachChildControl } from './task-tool-runtime-control';
import {
    abortListenerCounts,
    cleanupLifecycleHosts,
    createLifecycleHost,
    makeLifecycleServices,
} from './task-tool-runtime-lifecycle-test-support';

afterEach(async () => {
    vi.restoreAllMocks();
    await cleanupLifecycleHosts();
});

describe('attachChildControl lifecycle', () => {
    it('removes the named upstream abort listener when host attachment rejects', async () => {
        const fixture = await createLifecycleHost('child-attach-reject');
        const services = makeLifecycleServices({ host: fixture.host });
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const attachError = new Error('attach rejected');
        vi.spyOn(fixture.host, 'attachEntity').mockRejectedValue(attachError);

        await expect(attachChildControl(services, fixture.sessionId, controller.signal)).rejects.toBe(attachError);

        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('forwards upstream abort and removes its listener on disposal', async () => {
        const fixture = await createLifecycleHost('child-upstream-abort');
        const services = makeLifecycleServices({ host: fixture.host });
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const controlled = await attachChildControl(services, fixture.sessionId, controller.signal);

        controller.abort();
        await controlled.dispose();

        expect(controlled.signal.aborted).toBe(true);
        expect(counts()).toEqual({ added: 1, removed: 1 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('removes the listener and detaches exactly once across repeated disposal', async () => {
        const fixture = await createLifecycleHost('child-repeat-dispose');
        const services = makeLifecycleServices({ host: fixture.host });
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const detach = vi.fn(async () => undefined);
        vi.spyOn(fixture.host, 'attachEntity').mockResolvedValue({ detach });
        const controlled = await attachChildControl(services, fixture.sessionId, controller.signal);

        await controlled.dispose();
        await controlled.dispose();

        expect(detach).toHaveBeenCalledTimes(1);
        expect(counts()).toEqual({ added: 1, removed: 1 });
    });

    it('shares one detach completion across concurrent disposal', async () => {
        const fixture = await createLifecycleHost('child-concurrent-dispose');
        const services = makeLifecycleServices({ host: fixture.host });
        let finishDetach: (() => void) | undefined;
        const detach = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    finishDetach = resolve;
                }),
        );
        vi.spyOn(fixture.host, 'attachEntity').mockResolvedValue({ detach });
        const controlled = await attachChildControl(services, fixture.sessionId, undefined);

        const first = controlled.dispose();
        const second = controlled.dispose();

        expect(first).toBe(second);
        await Promise.resolve();
        expect(detach).toHaveBeenCalledTimes(1);
        finishDetach?.();
        await Promise.all([first, second]);
    });

    it('attaches with an already-aborted upstream signal without installing a listener', async () => {
        const fixture = await createLifecycleHost('child-pre-aborted');
        const services = makeLifecycleServices({ host: fixture.host });
        const controller = new AbortController();
        controller.abort();
        const counts = abortListenerCounts(controller);

        const controlled = await attachChildControl(services, fixture.sessionId, controller.signal);
        await controlled.dispose();

        expect(controlled.signal.aborted).toBe(true);
        expect(counts()).toEqual({ added: 0, removed: 0 });
        expect(fixture.host.classify(fixture.sessionId)).toEqual({ kind: 'absent' });
    });

    it('does not retry a rejecting detach during repeated disposal', async () => {
        const fixture = await createLifecycleHost('child-rejecting-dispose');
        const services = makeLifecycleServices({ host: fixture.host });
        const controller = new AbortController();
        const counts = abortListenerCounts(controller);
        const detachError = new Error('detach rejected');
        const detach = vi.fn(async () => Promise.reject(detachError));
        vi.spyOn(fixture.host, 'attachEntity').mockResolvedValue({ detach });
        const controlled = await attachChildControl(services, fixture.sessionId, controller.signal);

        const first = controlled.dispose();
        const second = controlled.dispose();
        await expect(first).rejects.toBe(detachError);
        await expect(second).rejects.toBe(detachError);

        expect(detach).toHaveBeenCalledTimes(1);
        expect(counts()).toEqual({ added: 1, removed: 1 });
    });
});
