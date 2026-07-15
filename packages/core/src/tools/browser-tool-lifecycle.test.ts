import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    BrowserHarness,
    callLifecycle,
    createRegistration,
    toolContext,
} from './browser-tool-lifecycle-test-support';

describe('browser tool page lifecycle', () => {
    afterEach(() => vi.useRealTimers());

    it('extracts from the page navigated by the previous action', async () => {
        const harness = new BrowserHarness();
        const registration = createRegistration(harness);

        await registration?.execute({ action: 'navigate', url: 'https://page-a.test' }, toolContext());
        const output = await registration?.execute({ action: 'extract' }, toolContext());

        expect(harness.connections).toHaveLength(1);
        expect(harness.newPageCalls).toBe(1);
        expect(output?.url).toBe('https://page-a.test');
        expect(output?.text).toBe('text:https://page-a.test');
    });

    it('passes a direct browserWSEndpoint to the connector unchanged', async () => {
        const harness = new BrowserHarness();
        const endpoint = { browserWSEndpoint: 'ws://127.0.0.1:9222/devtools/browser/browser-id' } as const;
        const registration = createRegistration(harness, { endpoint });

        await registration.execute({ action: 'extract' }, toolContext());

        expect(harness.endpoints).toEqual([endpoint]);
    });

    it('screenshots the page navigated by the previous action', async () => {
        const harness = new BrowserHarness();
        const registration = createRegistration(harness);

        await registration?.execute({ action: 'navigate', url: 'https://page-a.test' }, toolContext());
        const output = await registration?.execute({ action: 'screenshot' }, toolContext());

        expect(harness.newPageCalls).toBe(1);
        expect(output?.url).toBe('https://page-a.test');
        expect(output?.screenshotBase64).toBe('AQID');
    });

    it('serializes concurrent first page acquisition', async () => {
        const harness = new BrowserHarness();
        const registration = createRegistration(harness);

        await Promise.all([
            registration?.execute({ action: 'extract' }, toolContext()),
            registration?.execute({ action: 'screenshot' }, toolContext()),
        ]);

        expect(harness.connections).toHaveLength(1);
        expect(harness.newPageCalls).toBe(1);
    });

    it('does not acquire a page for a pre-aborted action', async () => {
        const harness = new BrowserHarness();
        const registration = createRegistration(harness);

        await expect(registration?.execute({ action: 'extract' }, toolContext(AbortSignal.abort()))).rejects.toThrow(
            'aborted',
        );

        expect(harness.connections).toHaveLength(0);
    });

    it('resets a dropped connection and closes its page before creating a fresh page', async () => {
        const harness = new BrowserHarness();
        const registration = createRegistration(harness);
        await registration?.execute({ action: 'navigate', url: 'https://page-a.test' }, toolContext());

        harness.connections[0]?.drop();
        await registration?.execute({ action: 'extract' }, toolContext());

        expect(harness.connections).toHaveLength(2);
        expect(harness.pages).toHaveLength(2);
        expect(harness.pages[0]?.closeCalls).toBe(1);
    });

    it('creates a fresh page after an explicit connection reset', async () => {
        const harness = new BrowserHarness();
        const registration = createRegistration(harness);
        await registration?.execute({ action: 'navigate', url: 'https://page-a.test' }, toolContext());

        await callLifecycle(registration, 'reset');
        const output = await registration?.execute({ action: 'extract' }, toolContext());

        expect(harness.pages).toHaveLength(2);
        expect(harness.pages[0]?.closeCalls).toBe(1);
        expect(output?.url).toBe('about:blank');
    });

    it('does not reuse a page that was closed outside the manager', async () => {
        const harness = new BrowserHarness();
        const registration = createRegistration(harness);
        await registration?.execute({ action: 'navigate', url: 'https://page-a.test' }, toolContext());
        await harness.pages[0]?.close();

        const output = await registration?.execute({ action: 'extract' }, toolContext());

        expect(harness.pages).toHaveLength(2);
        expect(output?.url).toBe('about:blank');
    });

    it('closes the active page and connection exactly once on shutdown', async () => {
        const harness = new BrowserHarness();
        const registration = createRegistration(harness);
        await registration?.execute({ action: 'navigate', url: 'https://page-a.test' }, toolContext());

        await callLifecycle(registration, 'close');
        await callLifecycle(registration, 'close');

        expect(harness.pages[0]?.closeCalls).toBe(1);
        expect(harness.connections[0]?.disconnectCalls).toBe(1);
    });

    it('redacts cleanup errors without writing raw secrets', async () => {
        const secret = 'browser_cleanup_secret';
        const harness = new BrowserHarness({ closeError: secret, disconnectError: secret });
        const registration = createRegistration(harness, { redactionSecrets: [secret] });
        await registration?.execute({ action: 'extract' }, toolContext());

        await callLifecycle(registration, 'close');
        const observable = JSON.stringify(registration?.getCleanupErrors());

        expect(observable).toContain('[REDACTED_CREDENTIAL]');
        expect(observable).not.toContain(secret);
    });

    it('closes the page and connection when an action fails', async () => {
        const harness = new BrowserHarness({ extractionError: 'renderer crashed' });
        const registration = createRegistration(harness);

        await expect(registration?.execute({ action: 'extract' }, toolContext())).rejects.toThrow('renderer crashed');

        expect(harness.pages[0]?.closeCalls).toBe(1);
        expect(harness.connections[0]?.disconnectCalls).toBe(1);
    });

    it('disconnects a connection whose first page creation fails', async () => {
        const harness = new BrowserHarness({ newPageError: 'target creation failed' });
        const registration = createRegistration(harness);

        await expect(registration?.execute({ action: 'extract' }, toolContext())).rejects.toThrow(
            'target creation failed',
        );

        expect(harness.pages).toHaveLength(0);
        expect(harness.connections[0]?.disconnectCalls).toBe(1);
    });

    it('bounds a never-resolving screenshot and cleans up its page', async () => {
        vi.useFakeTimers();
        const harness = new BrowserHarness({ hangScreenshot: true });
        const registration = createRegistration(harness);
        const settled = vi.fn();

        const pending = Promise.resolve(registration?.execute({ action: 'screenshot', timeout: 1 }, toolContext()));
        void pending.then(settled, settled);
        await vi.advanceTimersByTimeAsync(1_000);
        const output = await pending;

        expect(settled).toHaveBeenCalledOnce();
        expect(output?.status).toBe('timed_out');
        expect(harness.pages[0]?.closeCalls).toBe(1);
    });

    it('bounds never-resolving page acquisition and disconnects the connection', async () => {
        vi.useFakeTimers();
        const harness = new BrowserHarness({ hangNewPage: true });
        const registration = createRegistration(harness);
        const settled = vi.fn();

        const pending = Promise.resolve(registration?.execute({ action: 'extract', timeout: 1 }, toolContext()));
        void pending.then(settled, settled);
        await vi.advanceTimersByTimeAsync(1_000);
        const output = await pending;

        expect(settled).toHaveBeenCalledOnce();
        expect(output?.status).toBe('timed_out');
        expect(harness.connections[0]?.disconnectCalls).toBe(1);
    });
});
