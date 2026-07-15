import type { PermissionDecision } from '@mission-control/protocol';
import {
    type BrowserConnectionSeam,
    type BrowserPageSeam,
    type BrowserToolOptions,
    type BrowserWaitUntil,
    createBrowserToolRegistration,
} from './browser-tool.js';
import { projectTrustReader } from './browser-tool-test-support.js';
import type { ToolExecutionError } from './tool-registry-types.js';

export type BrowserHarnessOptions = {
    readonly actionToolErrors?: Readonly<Partial<Record<'extract' | 'navigate' | 'screenshot', ToolExecutionError>>>;
    readonly connectHook?: () => Promise<void>;
    readonly extractionError?: string;
    readonly closeError?: string;
    readonly closeErrorLeavesPageOpen?: boolean;
    readonly disconnectError?: string;
    readonly gotoHook?: (url: string) => Promise<void>;
    readonly hangClose?: boolean;
    readonly hangDisconnect?: boolean;
    readonly hangNewPage?: boolean;
    readonly hangScreenshot?: boolean;
    readonly newPageHook?: () => Promise<void>;
    readonly newPageError?: string;
    readonly removeDisconnectListenerError?: string;
    readonly screenshotStarted?: () => void;
};

export class LifecyclePage implements BrowserPageSeam {
    #currentUrl = 'about:blank';
    #closed = false;
    closeCalls = 0;
    extractHtmlCalls = 0;
    extractTextCalls = 0;
    gotoCalls = 0;
    screenshotCalls = 0;
    titleCalls = 0;

    constructor(private readonly options: BrowserHarnessOptions) {}

    get closed(): boolean {
        return this.#closed;
    }

    async goto(url: string, _waitUntil: BrowserWaitUntil): Promise<void> {
        this.gotoCalls += 1;
        const failure = this.options.actionToolErrors?.navigate;
        if (failure !== undefined) throw failure;
        this.#currentUrl = url;
        await this.options.gotoHook?.(url);
    }

    url(): string {
        return this.#currentUrl;
    }

    async title(): Promise<string> {
        this.titleCalls += 1;
        return `title:${this.#currentUrl}`;
    }

    async extractText(): Promise<string> {
        this.extractTextCalls += 1;
        const failure = this.options.actionToolErrors?.extract;
        if (failure !== undefined) throw failure;
        if (this.options.extractionError !== undefined) throw new Error(this.options.extractionError);
        return `text:${this.#currentUrl}`;
    }

    async extractHtml(): Promise<string> {
        this.extractHtmlCalls += 1;
        if (this.options.extractionError !== undefined) throw new Error(this.options.extractionError);
        return `<main>${this.#currentUrl}</main>`;
    }

    async screenshot(): Promise<Uint8Array> {
        this.screenshotCalls += 1;
        const failure = this.options.actionToolErrors?.screenshot;
        if (failure !== undefined) throw failure;
        if (this.options.hangScreenshot === true) {
            this.options.screenshotStarted?.();
            return new Promise<Uint8Array>(() => undefined);
        }
        return new Uint8Array([1, 2, 3]);
    }

    async close(): Promise<void> {
        this.closeCalls += 1;
        if (this.options.hangClose === true) return new Promise<void>(() => undefined);
        if (this.options.closeErrorLeavesPageOpen !== true) this.#closed = true;
        if (this.options.closeError !== undefined) throw new Error(this.options.closeError);
    }
}

export class LifecycleConnection implements BrowserConnectionSeam {
    #connected = true;
    readonly #disconnectListeners = new Set<() => void>();
    readonly pages: LifecyclePage[] = [];
    disconnectCalls = 0;
    newPageCalls = 0;

    constructor(private readonly options: BrowserHarnessOptions) {}

    get connected(): boolean {
        return this.#connected;
    }

    async newPage(): Promise<LifecyclePage> {
        this.newPageCalls += 1;
        await this.options.newPageHook?.();
        if (this.options.hangNewPage === true) return new Promise<LifecyclePage>(() => undefined);
        if (this.options.newPageError !== undefined) throw new Error(this.options.newPageError);
        const page = new LifecyclePage(this.options);
        this.pages.push(page);
        return page;
    }

    onDisconnected(listener: () => void): () => void {
        this.#disconnectListeners.add(listener);
        return () => {
            if (this.options.removeDisconnectListenerError !== undefined) {
                throw new Error(this.options.removeDisconnectListenerError);
            }
            this.#disconnectListeners.delete(listener);
        };
    }

    drop(): void {
        this.#connected = false;
        for (const listener of this.#disconnectListeners) listener();
    }

    async disconnect(): Promise<void> {
        this.disconnectCalls += 1;
        if (this.options.hangDisconnect === true) return new Promise<void>(() => undefined);
        this.#connected = false;
        if (this.options.disconnectError !== undefined) throw new Error(this.options.disconnectError);
    }
}

export class BrowserHarness {
    readonly connections: LifecycleConnection[] = [];
    readonly endpoints: Parameters<NonNullable<BrowserToolOptions['connect']>>[0][] = [];
    readonly connect: NonNullable<BrowserToolOptions['connect']>;

    constructor(options: BrowserHarnessOptions = {}) {
        this.connect = async (endpoint) => {
            this.endpoints.push(endpoint);
            const connection = new LifecycleConnection(options);
            this.connections.push(connection);
            await options.connectHook?.();
            return connection;
        };
    }

    get pages(): readonly LifecyclePage[] {
        return this.connections.flatMap((connection) => connection.pages);
    }

    get newPageCalls(): number {
        return this.connections.reduce((total, connection) => total + connection.newPageCalls, 0);
    }
}

export function createRegistration(
    harness: BrowserHarness,
    overrides: Partial<Pick<BrowserToolOptions, 'endpoint' | 'protocolTimeoutMs' | 'redactionSecrets'>> = {},
) {
    return createBrowserToolRegistration({
        workspaceRoot: '/workspace',
        projectTrustStore: projectTrustReader('trusted'),
        endpoint: overrides.endpoint ?? { browserURL: 'http://127.0.0.1:9222' },
        requestPermission: allowAll,
        connect: harness.connect,
        ...(overrides.protocolTimeoutMs !== undefined ? { protocolTimeoutMs: overrides.protocolTimeoutMs } : {}),
        ...(overrides.redactionSecrets !== undefined ? { redactionSecrets: overrides.redactionSecrets } : {}),
    });
}

export async function callLifecycle(registration: object | null, operation: 'close' | 'reset'): Promise<void> {
    const lifecycle = registration === null ? undefined : Reflect.get(registration, operation);
    if (typeof lifecycle !== 'function') throw new Error(`missing browser lifecycle operation: ${operation}`);
    await Reflect.apply(lifecycle, registration, []);
}

export function toolContext(signal: AbortSignal = new AbortController().signal) {
    return { toolCallId: 'browser-call', toolName: 'browser', signal };
}

function allowAll(request: { readonly id: string }): PermissionDecision {
    return { requestId: request.id, status: 'allow' };
}
