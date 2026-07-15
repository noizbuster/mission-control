import type { PermissionDecision } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type BrowserConnectFn, createBrowserToolRegistration } from './browser-tool.js';
import { BrowserHarness, createRegistration, toolContext } from './browser-tool-lifecycle-test-support.js';
import { projectTrustReader } from './browser-tool-test-support.js';
import { ToolExecutionError } from './tool-registry-types.js';

describe('browser tool adversarial lifecycle', () => {
    afterEach(() => vi.useRealTimers());

    it('serializes concurrent actions that mutate the shared page', async () => {
        const firstStarted = deferredVoid();
        const releaseFirst = deferredVoid();
        const navigations: string[] = [];
        const harness = new BrowserHarness({
            gotoHook: async (url) => {
                navigations.push(url);
                if (url === 'https://page-a.test') {
                    firstStarted.resolve();
                    await releaseFirst.promise;
                }
            },
        });
        const registration = createRegistration(harness);

        const first = Promise.resolve(
            registration?.execute({ action: 'navigate', url: 'https://page-a.test' }, toolContext()),
        );
        await firstStarted.promise;
        const second = Promise.resolve(
            registration?.execute({ action: 'navigate', url: 'https://page-b.test' }, toolContext()),
        );
        await Promise.resolve();

        expect(navigations).toEqual(['https://page-a.test']);
        releaseFirst.resolve();
        const [firstOutput, secondOutput] = await Promise.all([first, second]);
        expect(firstOutput?.url).toBe('https://page-a.test');
        expect(secondOutput?.url).toBe('https://page-b.test');
    });

    it('times out a queued action without cancelling the active action', async () => {
        vi.useFakeTimers();
        const firstStarted = deferredVoid();
        const releaseFirst = deferredVoid();
        const harness = new BrowserHarness({
            gotoHook: async (url) => {
                if (url === 'https://page-a.test') {
                    firstStarted.resolve();
                    await releaseFirst.promise;
                }
            },
        });
        const registration = createRegistration(harness);
        const first = Promise.resolve(
            registration?.execute({ action: 'navigate', url: 'https://page-a.test' }, toolContext()),
        );
        await firstStarted.promise;

        const queued = Promise.resolve(registration?.execute({ action: 'extract', timeout: 1 }, toolContext()));
        await vi.advanceTimersByTimeAsync(1_000);
        const queuedOutput = await queued;
        releaseFirst.resolve();
        const firstOutput = await first;

        expect(queuedOutput?.status).toBe('timed_out');
        expect(firstOutput?.status).toBe('completed');
        expect(firstOutput?.url).toBe('https://page-a.test');
    });

    it('bounds shutdown when page close and disconnect never resolve', async () => {
        vi.useFakeTimers();
        const harness = new BrowserHarness({ hangClose: true, hangDisconnect: true });
        const registration = createRegistration(harness, { protocolTimeoutMs: 25 });
        await registration?.execute({ action: 'extract' }, toolContext());
        const settled = vi.fn();

        const closing = registration?.close();
        void closing?.then(settled, settled);
        await vi.advanceTimersByTimeAsync(75);

        expect(settled).toHaveBeenCalledOnce();
        expect(harness.pages[0]?.closeCalls).toBe(1);
        expect(harness.connections[0]?.disconnectCalls).toBe(1);
    });

    it('cancels a never-resolving active action during shutdown', async () => {
        vi.useFakeTimers();
        const screenshotStarted = deferredVoid();
        const harness = new BrowserHarness({
            hangScreenshot: true,
            screenshotStarted: screenshotStarted.resolve,
        });
        const registration = createRegistration(harness, { protocolTimeoutMs: 25 });
        const settled = vi.fn();
        const action = Promise.resolve(registration?.execute({ action: 'screenshot' }, toolContext()));
        void action.then(settled, settled);
        await screenshotStarted.promise;

        const closing = registration?.close();
        await vi.advanceTimersByTimeAsync(25);
        await closing;
        await Promise.resolve();

        expect(settled).toHaveBeenCalledOnce();
        expect(harness.pages[0]?.closeCalls).toBe(1);
    });

    it('redacts a synchronously thrown ToolExecutionError and its events', async () => {
        const secret = 'synchronous_connector_secret';
        const connect: BrowserConnectFn = () => {
            throw new ToolExecutionError({ code: 'tool_failed', message: secret, retryable: false }, [
                { type: 'log', timestamp: '2026-07-14T00:00:00.000Z', message: secret },
            ]);
        };
        const registration = createBrowserToolRegistration({
            workspaceRoot: '/workspace',
            projectTrustStore: projectTrustReader('trusted'),
            endpoint: { browserURL: 'http://127.0.0.1:9222' },
            requestPermission: allowAll,
            connect,
            redactionSecrets: [secret],
        });

        const failure = registration?.execute({ action: 'extract' }, toolContext());

        await expect(failure).rejects.not.toThrow(secret);
        await expect(failure).rejects.toMatchObject({
            message: expect.stringContaining('[REDACTED_CREDENTIAL]'),
            events: [expect.objectContaining({ message: expect.stringContaining('[REDACTED_CREDENTIAL]') })],
        });
    });

    it('does not start replacement actions while a timed-out page operation remains unresolved', async () => {
        vi.useFakeTimers();
        const screenshotStarted = vi.fn();
        const harness = new BrowserHarness({ hangScreenshot: true, screenshotStarted });
        const registration = createRegistration(harness);

        const first = registration?.execute({ action: 'screenshot', timeout: 1 }, toolContext());
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await first)?.status).toBe('timed_out');

        const second = registration?.execute({ action: 'screenshot', timeout: 1 }, toolContext());
        await Promise.resolve();
        expect(screenshotStarted).toHaveBeenCalledOnce();
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await second)?.status).toBe('timed_out');
        expect(harness.pages).toHaveLength(1);
    });

    it('does not accumulate connections while a timed-out page acquisition remains unresolved', async () => {
        vi.useFakeTimers();
        const harness = new BrowserHarness({ hangNewPage: true });
        const registration = createRegistration(harness);

        const first = registration?.execute({ action: 'extract', timeout: 1 }, toolContext());
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await first)?.status).toBe('timed_out');

        const second = registration?.execute({ action: 'extract', timeout: 1 }, toolContext());
        await Promise.resolve();
        expect(harness.connections).toHaveLength(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect((await second)?.status).toBe('timed_out');
        expect(harness.connections).toHaveLength(1);
    });

    it('attempts page close only once when close rejects before the page reports closed', async () => {
        const harness = new BrowserHarness({
            closeError: 'close rejected',
            closeErrorLeavesPageOpen: true,
        });
        const registration = createRegistration(harness);
        await registration?.execute({ action: 'extract' }, toolContext());

        await registration?.close();
        await registration?.close();

        expect(harness.pages[0]?.closeCalls).toBe(1);
    });

    it('quarantines replacement acquisition when stale-page reset cleanup fails', async () => {
        const harness = new BrowserHarness({
            disconnectError: 'disconnect rejected',
            removeDisconnectListenerError: 'listener removal rejected',
        });
        const registration = createRegistration(harness);
        await registration?.execute({ action: 'extract' }, toolContext());
        await harness.pages[0]?.close();

        const replacement = registration?.execute({ action: 'extract' }, toolContext());

        await expect(replacement).rejects.toThrow('previous browser resource cleanup failed');
        expect(harness.connections).toHaveLength(1);
    });
});

function deferredVoid(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}

function allowAll(request: { readonly id: string }): PermissionDecision {
    return { requestId: request.id, status: 'allow' };
}
