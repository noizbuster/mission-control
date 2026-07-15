import type { PermissionDecision } from '@mission-control/protocol';
import type { ProjectTrustDecision, ProjectTrustReader } from '../trust/project-trust-store.js';
import type { BrowserConnectFn, BrowserPageSeam, BrowserToolOptions, BrowserWaitUntil } from './browser-tool.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

export interface MockPageConfig {
    readonly url?: string;
    readonly title?: string;
    readonly text?: string;
    readonly html?: string;
    readonly screenshotBytes?: number;
}

export async function makeBrowserToolWorkspace(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'browser-tool-test-'));
    tempDirs.push(dir);
    return dir;
}

export async function cleanupBrowserToolWorkspaces(): Promise<void> {
    const dirs = tempDirs.splice(0, tempDirs.length);
    await Promise.all(dirs.map((dir) => rm(dir, { recursive: true, force: true })));
}

export function allowAllBrowserPermissions(): (request: { readonly id: string }) => Promise<PermissionDecision> {
    return async () => ({ requestId: 'r', status: 'allow' });
}

export function denyAllBrowserPermissions(): (request: { readonly id: string }) => Promise<PermissionDecision> {
    return async () => ({ requestId: 'r', status: 'deny', reason: 'blocked' });
}

export function browserToolContext() {
    return { toolCallId: 'tc1', toolName: 'browser', signal: new AbortController().signal };
}

export function mockBrowserCdp(pageConfig: MockPageConfig = {}): {
    readonly connect: BrowserConnectFn;
    readonly pages: readonly MockBrowserPageSeam[];
    readonly connections: number;
    readonly gotoCalls: readonly { readonly url: string; readonly waitUntil: BrowserWaitUntil }[];
} {
    const pages: MockBrowserPageSeam[] = [];
    const gotoCalls: { url: string; waitUntil: BrowserWaitUntil }[] = [];
    let connections = 0;
    const connect: BrowserConnectFn = async () => {
        connections += 1;
        return {
            connected: true,
            async newPage(): Promise<BrowserPageSeam> {
                const page = new MockBrowserPageSeam(pageConfig, gotoCalls);
                pages.push(page);
                return page;
            },
            async disconnect() {},
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

export class MockBrowserPageSeam implements BrowserPageSeam {
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
        this.#currentUrl = this.#config.url ?? url;
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
        return new Uint8Array(this.#config.screenshotBytes ?? 1024);
    }

    async close(): Promise<void> {}
}

export async function browserToolOptions(
    overrides: Partial<BrowserToolOptions> & { readonly connect: BrowserConnectFn },
): Promise<BrowserToolOptions> {
    return {
        workspaceRoot: await makeBrowserToolWorkspace(),
        projectTrustStore: projectTrustReader('trusted'),
        endpoint: { browserURL: 'http://127.0.0.1:9222' },
        requestPermission: allowAllBrowserPermissions(),
        ...overrides,
    };
}

export function projectTrustReader(decision: ProjectTrustDecision): ProjectTrustReader {
    return {
        getDecision: async (workspaceRoot) => ({
            decision,
            workspaceRoot,
            filePath: '/test/trust/projects.json',
            storeState: 'valid',
        }),
    };
}
