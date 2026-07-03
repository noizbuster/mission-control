import type { PermissionDecision } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import {
    type BrowserConnectFn,
    type BrowserConnectionSeam,
    type BrowserInput,
    type BrowserPageSeam,
    type BrowserToolOptions,
    type BrowserWaitUntil,
    createBrowserToolRegistration,
    registerBrowserTool,
} from './browser-tool.js';
import { ToolRegistry } from './tool-registry.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

async function makeWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'browser-tool-test-'));
    tempDirs.push(dir);
    return dir;
}

function allowAll(): (request: { readonly id: string }) => Promise<PermissionDecision> {
    return async () => ({ requestId: 'r', status: 'allow' });
}

function denyAll(): (request: { readonly id: string }) => Promise<PermissionDecision> {
    return async () => ({ requestId: 'r', status: 'deny', reason: 'blocked' });
}

function toolContext() {
    return { toolCallId: 'tc1', toolName: 'browser', signal: new AbortController().signal };
}

interface MockPageConfig {
    readonly url?: string;
    readonly title?: string;
    readonly text?: string;
    readonly html?: string;
    readonly screenshotBytes?: number;
}

/**
 * Build a fully mocked CDP surface: a connect fn that records calls and returns
 * a mock connection whose `newPage` yields mock pages. This is the seam the
 * browser tool drives — no puppeteer-core, no real Chrome.
 */
function mockCdp(pageConfig: MockPageConfig = {}): {
    readonly connect: BrowserConnectFn;
    readonly pages: MockPageSeam[];
    readonly connections: number;
    readonly gotoCalls: { readonly url: string; readonly waitUntil: BrowserWaitUntil }[];
} {
    const pages: MockPageSeam[] = [];
    const gotoCalls: { url: string; waitUntil: BrowserWaitUntil }[] = [];
    let connections = 0;
    const connect: BrowserConnectFn = async () => {
        connections += 1;
        return {
            connected: true,
            async newPage(): Promise<MockPageSeam> {
                const page = new MockPageSeam(pageConfig, gotoCalls);
                pages.push(page);
                return page;
            },
            async disconnect() {
                /* no-op */
            },
        };
    };
    return {
        connect,
        get pages() {
            return pages;
        },
        get connections() {
            return connections;
        },
        get gotoCalls() {
            return gotoCalls;
        },
    };
}

class MockPageSeam implements BrowserPageSeam {
    readonly #config: MockPageConfig;
    readonly #gotoCalls: { url: string; waitUntil: BrowserWaitUntil }[];
    #currentUrl: string;

    constructor(config: MockPageConfig, gotoCalls: { url: string; waitUntil: BrowserWaitUntil }[]) {
        this.#config = config;
        this.#gotoCalls = gotoCalls;
        this.#currentUrl = config.url ?? 'about:blank';
    }

    async goto(url: string, waitUntil: BrowserWaitUntil): Promise<void> {
        this.#gotoCalls.push({ url, waitUntil });
        this.#currentUrl = url;
    }

    url(): string {
        return this.#currentUrl;
    }

    async title(): Promise<string> {
        return this.#config.title ?? '';
    }

    async extractText(): Promise<string> {
        return this.#config.text ?? '';
    }

    async extractHtml(): Promise<string> {
        return this.#config.html ?? `<html>${this.#config.text ?? ''}</html>`;
    }

    async screenshot(): Promise<Uint8Array> {
        const size = this.#config.screenshotBytes ?? 1024;
        return new Uint8Array(size);
    }

    async close(): Promise<void> {
        /* no-op */
    }
}

function baseOptions(
    overrides: Partial<BrowserToolOptions> & { readonly connect: BrowserConnectFn },
): Promise<BrowserToolOptions> {
    return makeWorkspace().then((workspaceRoot) => ({
        workspaceRoot,
        workspaceTrust: 'trusted',
        chromeEndpoint: 'http://127.0.0.1:9222',
        requestPermission: allowAll(),
        ...overrides,
    }));
}

describe('browser tool', () => {
    afterEach(async () => {
        const dirs = tempDirs.splice(0, tempDirs.length);
        await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
    });

    it('returns null registration when no chrome endpoint is configured (config-gated)', async () => {
        const registration = createBrowserToolRegistration({
            ...(await baseOptions({ connect: mockCdp().connect })),
            chromeEndpoint: '',
        });
        expect(registration).toBeNull();
    });

    it('refuses on an untrusted workspace', async () => {
        const cdp = mockCdp({ text: 'hello' });
        const registration = createBrowserToolRegistration({
            ...(await baseOptions({ connect: cdp.connect })),
            workspaceTrust: 'denied',
        });
        expect(registration).not.toBeNull();
        const input: BrowserInput = { action: 'navigate', url: 'https://example.com' };
        await expect(registration?.execute(input, toolContext())).rejects.toThrow(/trust/i);
    });

    it('requires approval and surfaces denial as an error', async () => {
        const cdp = mockCdp({ text: 'hello' });
        const registration = createBrowserToolRegistration({
            ...(await baseOptions({ connect: cdp.connect })),
            requestPermission: denyAll(),
        });
        expect(registration).not.toBeNull();
        await expect(
            registration?.execute({ action: 'navigate', url: 'https://example.com' }, toolContext()),
        ).rejects.toThrow(/approval_denied/);
    });

    it('navigates to a URL and extracts readable text via mocked CDP', async () => {
        const cdp = mockCdp({
            title: 'Example Domain',
            text: 'This domain is for use in illustrative examples.\nMore text here.',
        });
        const registration = createBrowserToolRegistration(await baseOptions({ connect: cdp.connect }));
        expect(registration).not.toBeNull();
        const output = await registration?.execute({ action: 'navigate', url: 'https://example.com' }, toolContext());
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
        const cdp = mockCdp({ text: 'content' });
        const registration = createBrowserToolRegistration(await baseOptions({ connect: cdp.connect }));
        await registration?.execute(
            { action: 'navigate', url: 'https://example.com', waitUntil: 'networkidle0' },
            toolContext(),
        );
        expect(cdp.gotoCalls[0]?.waitUntil).toBe('networkidle0');
    });

    it('reuses the cached CDP connection across calls', async () => {
        const cdp = mockCdp({ text: 'page content' });
        const registration = createBrowserToolRegistration(await baseOptions({ connect: cdp.connect }));
        await registration?.execute({ action: 'navigate', url: 'https://a.test' }, toolContext());
        await registration?.execute({ action: 'extract' }, toolContext());
        expect(cdp.connections).toBe(1);
    });

    it('extracts HTML when format is html', async () => {
        const cdp = mockCdp({ html: '<html><body>raw html</body></html>' });
        const registration = createBrowserToolRegistration(await baseOptions({ connect: cdp.connect }));
        const output = await registration?.execute({ action: 'extract', format: 'html' }, toolContext());
        expect(output?.text).toContain('raw html');
    });

    it('captures a screenshot and caps oversized bytes', async () => {
        const cdp = mockCdp({ screenshotBytes: 512 * 1024 });
        const registration = createBrowserToolRegistration(
            await baseOptions({ connect: cdp.connect, maxScreenshotBytes: 64 * 1024 }),
        );
        const output = await registration?.execute({ action: 'screenshot' }, toolContext());
        expect(output?.action).toBe('screenshot');
        expect(output?.screenshotBytes).toBeLessThanOrEqual(64 * 1024);
        expect(output?.screenshotBase64).toBeDefined();
        expect(output?.screenshotBase64?.length).toBeGreaterThan(0);
    });

    it('redacts configured secrets from extracted text', async () => {
        const secret = 'SUPER_SECRET_TOKEN_123';
        const cdp = mockCdp({ text: `The token is ${secret} here.` });
        const registration = createBrowserToolRegistration(
            await baseOptions({ connect: cdp.connect, redactionSecrets: [secret] }),
        );
        const output = await registration?.execute({ action: 'navigate', url: 'https://secret.test' }, toolContext());
        expect(output?.text).not.toContain(secret);
    });

    it('truncates extracted text that exceeds the model output limit', async () => {
        const longText = 'A'.repeat(20_000);
        const cdp = mockCdp({ text: longText });
        const registration = createBrowserToolRegistration(
            await baseOptions({ connect: cdp.connect, maxModelOutputChars: 1000 }),
        );
        const output = await registration?.execute({ action: 'navigate', url: 'https://big.test' }, toolContext());
        expect(output?.truncated).toBe(true);
        expect(output?.originalLength).toBe(20_000);
        expect(output?.text?.length ?? 0).toBeLessThan(20_000);
    });

    it('errors when navigate is called without a url', async () => {
        const cdp = mockCdp({ text: 'x' });
        const registration = createBrowserToolRegistration(await baseOptions({ connect: cdp.connect }));
        await expect(registration?.execute({ action: 'navigate' }, toolContext())).rejects.toThrow(/requires a "url"/);
    });

    it('errors when the CDP connection fails', async () => {
        const failingConnect: BrowserConnectFn = async () => {
            throw new Error('ECONNREFUSED');
        };
        const registration = createBrowserToolRegistration(await baseOptions({ connect: failingConnect }));
        await expect(
            registration?.execute({ action: 'navigate', url: 'https://example.com' }, toolContext()),
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
                    return new MockPageSeam({ text: 'reconnected' }, []);
                },
                async disconnect() {
                    alive = false;
                },
            };
        };
        const registration = createBrowserToolRegistration(await baseOptions({ connect }));
        await registration?.execute({ action: 'navigate', url: 'https://first.test' }, toolContext());
        // Drop the connection, then the next call must reconnect.
        alive = false;
        await registration?.execute({ action: 'navigate', url: 'https://second.test' }, toolContext());
        expect(connectionCount).toBe(2);
    });

    it('registers through a ToolRegistry when an endpoint is configured', async () => {
        const workspaceRoot = await makeWorkspace();
        const registry = new ToolRegistry();
        const advertisement = await registerBrowserTool(registry, {
            workspaceRoot,
            workspaceTrust: 'trusted',
            chromeEndpoint: 'http://127.0.0.1:9222',
            requestPermission: allowAll(),
            connect: mockCdp({ text: 'ok' }).connect,
        });
        expect(advertisement?.name).toBe('browser');
        expect(advertisement?.capabilityClasses).toContain('network');
        expect(advertisement?.capabilityClasses).toContain('exec');
    });

    it('returns null from registerBrowserTool when no endpoint is configured', async () => {
        const workspaceRoot = await makeWorkspace();
        const registry = new ToolRegistry();
        const advertisement = await registerBrowserTool(registry, {
            workspaceRoot,
            workspaceTrust: 'trusted',
            chromeEndpoint: '   ',
            requestPermission: allowAll(),
            connect: mockCdp().connect,
        });
        expect(advertisement).toBeNull();
    });

    it('has the expected registration shape', async () => {
        const registration = createBrowserToolRegistration(
            await baseOptions({ connect: mockCdp({ text: 'x' }).connect }),
        );
        expect(registration?.name).toBe('browser');
        expect(registration?.capabilityClasses).toEqual(['network', 'exec']);
        expect(registration?.inputSchema).toBeDefined();
        expect(registration?.outputSchema).toBeDefined();
        expect(typeof registration?.execute).toBe('function');
        expect(registration?.outputLimit.maxModelOutputChars).toBeGreaterThan(0);
    });
});
