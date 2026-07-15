import { afterEach, describe, expect, it } from 'vitest';
import {
    type BrowserConnectFn,
    type BrowserInput,
    createBrowserToolRegistration,
    registerBrowserTool,
} from './browser-tool';
import {
    allowAllBrowserPermissions,
    browserToolContext,
    browserToolOptions,
    cleanupBrowserToolWorkspaces,
    denyAllBrowserPermissions,
    MockBrowserPageSeam,
    makeBrowserToolWorkspace,
    mockBrowserCdp,
    projectTrustReader,
} from './browser-tool-test-support';
import { ToolRegistry } from './tool-registry';

describe('browser tool', () => {
    afterEach(async () => {
        await cleanupBrowserToolWorkspaces();
    });

    it('refuses on an untrusted workspace', async () => {
        const cdp = mockBrowserCdp({ text: 'hello' });
        const registration = createBrowserToolRegistration({
            ...(await browserToolOptions({ connect: cdp.connect })),
            projectTrustStore: projectTrustReader('denied'),
        });
        expect(registration).not.toBeNull();
        const input: BrowserInput = { action: 'navigate', url: 'https://example.com' };
        await expect(registration?.execute(input, browserToolContext())).rejects.toThrow(/trust/i);
    });

    it('requires approval and surfaces denial as an error', async () => {
        const cdp = mockBrowserCdp({ text: 'hello' });
        const registration = createBrowserToolRegistration({
            ...(await browserToolOptions({ connect: cdp.connect })),
            requestPermission: denyAllBrowserPermissions(),
        });
        expect(registration).not.toBeNull();
        await expect(
            registration?.execute({ action: 'navigate', url: 'https://example.com' }, browserToolContext()),
        ).rejects.toThrow(/approval_denied/);
    });

    it('navigates to a URL and extracts readable text via mocked CDP', async () => {
        const cdp = mockBrowserCdp({
            title: 'Example Domain',
            text: 'This domain is for use in illustrative examples.\nMore text here.',
        });
        const registration = createBrowserToolRegistration(await browserToolOptions({ connect: cdp.connect }));
        expect(registration).not.toBeNull();
        const output = await registration?.execute(
            { action: 'navigate', url: 'https://example.com' },
            browserToolContext(),
        );
        expect(output).toBeDefined();
        expect(output?.action).toBe('navigate');
        expect(output?.status).toBe('completed');
        expect(output?.url).toBe('https://example.com');
        expect(output?.title).toBe('Example Domain');
        expect(output?.text).toContain('illustrative examples');
        expect(output?.truncated).toBe(false);
        expect(cdp.connections).toBe(1);
        expect(cdp.gotoCalls.length).toBe(1);
        expect(cdp.gotoCalls[0]?.url).toBe('https://example.com');
        expect(cdp.gotoCalls[0]?.waitUntil).toBe('load');
    });

    it('respects a custom waitUntil condition', async () => {
        const cdp = mockBrowserCdp({ text: 'content' });
        const registration = createBrowserToolRegistration(await browserToolOptions({ connect: cdp.connect }));
        await registration?.execute(
            { action: 'navigate', url: 'https://example.com', waitUntil: 'networkidle0' },
            browserToolContext(),
        );
        expect(cdp.gotoCalls[0]?.waitUntil).toBe('networkidle0');
    });

    it('reuses the cached CDP connection across calls', async () => {
        const cdp = mockBrowserCdp({ text: 'page content' });
        const registration = createBrowserToolRegistration(await browserToolOptions({ connect: cdp.connect }));
        await registration?.execute({ action: 'navigate', url: 'https://a.test' }, browserToolContext());
        await registration?.execute({ action: 'extract' }, browserToolContext());
        expect(cdp.connections).toBe(1);
    });

    it('extracts HTML when format is html', async () => {
        const cdp = mockBrowserCdp({ html: '<html><body>raw html</body></html>' });
        const registration = createBrowserToolRegistration(await browserToolOptions({ connect: cdp.connect }));
        const output = await registration?.execute({ action: 'extract', format: 'html' }, browserToolContext());
        expect(output?.text).toContain('raw html');
    });

    it('captures a screenshot and caps oversized bytes', async () => {
        const cdp = mockBrowserCdp({ screenshotBytes: 512 * 1024 });
        const registration = createBrowserToolRegistration(
            await browserToolOptions({ connect: cdp.connect, maxScreenshotBytes: 64 * 1024 }),
        );
        const output = await registration?.execute({ action: 'screenshot' }, browserToolContext());
        expect(output?.action).toBe('screenshot');
        expect(output?.screenshotBytes).toBeLessThanOrEqual(64 * 1024);
        expect(output?.screenshotBase64).toBeDefined();
        expect(output?.screenshotBase64?.length).toBeGreaterThan(0);
    });

    it('truncates extracted text that exceeds the model output limit', async () => {
        const longText = 'A'.repeat(20_000);
        const cdp = mockBrowserCdp({ text: longText });
        const registration = createBrowserToolRegistration(
            await browserToolOptions({ connect: cdp.connect, maxModelOutputChars: 1000 }),
        );
        const output = await registration?.execute(
            { action: 'navigate', url: 'https://big.test' },
            browserToolContext(),
        );
        expect(output?.truncated).toBe(true);
        expect(output?.originalLength).toBe(20_000);
        expect(output?.text?.length ?? 0).toBeLessThan(20_000);
    });

    it('errors when navigate is called without a url', async () => {
        const cdp = mockBrowserCdp({ text: 'x' });
        const registration = createBrowserToolRegistration(await browserToolOptions({ connect: cdp.connect }));
        await expect(registration?.execute({ action: 'navigate' }, browserToolContext())).rejects.toThrow(
            /requires a "url"/,
        );
    });

    it('errors when the CDP connection fails', async () => {
        const failingConnect: BrowserConnectFn = async () => {
            throw new Error('ECONNREFUSED');
        };
        const registration = createBrowserToolRegistration(await browserToolOptions({ connect: failingConnect }));
        await expect(
            registration?.execute({ action: 'navigate', url: 'https://example.com' }, browserToolContext()),
        ).rejects.toThrow(/ECONNREFUSED/);
    });

    it('reconnects after a dropped connection', async () => {
        let connectionCount = 0;
        let alive = true;
        const connect: BrowserConnectFn = async () => {
            connectionCount += 1;
            alive = true;
            return {
                get connected() {
                    return alive;
                },
                async newPage() {
                    return new MockBrowserPageSeam({ text: 'reconnected' }, []);
                },
                async disconnect() {
                    alive = false;
                },
            };
        };
        const registration = createBrowserToolRegistration(await browserToolOptions({ connect }));
        await registration?.execute({ action: 'navigate', url: 'https://first.test' }, browserToolContext());
        // Drop the connection, then the next call must reconnect.
        alive = false;
        await registration?.execute({ action: 'navigate', url: 'https://second.test' }, browserToolContext());
        expect(connectionCount).toBe(2);
    });

    it('registers through a ToolRegistry when an endpoint is configured', async () => {
        const workspaceRoot = await makeBrowserToolWorkspace();
        const registry = new ToolRegistry();
        const advertisement = await registerBrowserTool(registry, {
            workspaceRoot,
            projectTrustStore: projectTrustReader('trusted'),
            endpoint: { browserURL: 'http://127.0.0.1:9222' },
            requestPermission: allowAllBrowserPermissions(),
            connect: mockBrowserCdp({ text: 'ok' }).connect,
        });
        expect(advertisement?.name).toBe('browser');
        expect(advertisement?.capabilityClasses).toContain('network');
        expect(advertisement?.capabilityClasses).toContain('exec');
    });

    it('has the expected registration shape', async () => {
        const registration = createBrowserToolRegistration(
            await browserToolOptions({ connect: mockBrowserCdp({ text: 'x' }).connect }),
        );
        expect(registration?.name).toBe('browser');
        expect(registration?.capabilityClasses).toEqual(['network', 'exec']);
        expect(registration?.inputSchema).toBeDefined();
        expect(registration?.outputSchema).toBeDefined();
        expect(typeof registration?.execute).toBe('function');
        expect(registration?.outputLimit.maxModelOutputChars).toBeGreaterThan(0);
    });
});
