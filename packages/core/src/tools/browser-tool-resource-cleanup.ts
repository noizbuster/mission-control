import type { ObservabilityRedactor } from '../providers/observability-redactor.js';
import { raceBrowserCleanup, raceBrowserOperation } from './browser-tool-deadline.js';
import { browserFailure } from './browser-tool-output.js';
import type { BrowserConnectionSeam, BrowserPageSeam } from './browser-tool-puppeteer.js';

const MAX_BROWSER_CLEANUP_ERRORS = 100;

export class BrowserResourceCleanup {
    readonly #cleanupErrors: string[] = [];
    readonly #closingPages = new WeakSet<BrowserPageSeam>();
    readonly #disconnectingConnections = new WeakSet<BrowserConnectionSeam>();
    readonly #lateTasks = new Set<Promise<void>>();
    #cleanupFailed = false;

    constructor(
        private readonly observabilityRedactor: ObservabilityRedactor,
        private readonly protocolTimeoutMs: number,
    ) {}

    getErrors(): readonly string[] {
        return [...this.#cleanupErrors];
    }

    connectionIsLive(connection: BrowserConnectionSeam): boolean {
        try {
            return connection.connected;
        } catch (error: unknown) {
            this.#record('failed to read browser connection state', error instanceof Error ? error : String(error));
            return false;
        }
    }

    pageIsReusable(page: BrowserPageSeam): boolean {
        try {
            return page.closed !== true;
        } catch (error: unknown) {
            this.#record('failed to read browser page state', error instanceof Error ? error : String(error));
            return false;
        }
    }

    async cleanup(
        connection: BrowserConnectionSeam,
        page: BrowserPageSeam | undefined,
        removeDisconnectListener: () => void = () => undefined,
    ): Promise<void> {
        try {
            removeDisconnectListener();
        } catch (error: unknown) {
            this.#cleanupFailed = true;
            this.#record(
                'failed to remove browser disconnect listener',
                error instanceof Error ? error : String(error),
            );
        }
        if (page !== undefined) await this.closePage(page);
        await this.disconnect(connection);
    }

    async closePage(page: BrowserPageSeam): Promise<void> {
        if (this.#closingPages.has(page)) return;
        let closed = false;
        try {
            closed = page.closed === true;
        } catch (error: unknown) {
            this.#record('failed to read browser page state', error instanceof Error ? error : String(error));
        }
        if (closed) return;
        this.#closingPages.add(page);
        await this.#settleTracked('failed to close browser page', () => page.close());
    }

    async disconnect(connection: BrowserConnectionSeam): Promise<void> {
        if (this.#disconnectingConnections.has(connection)) return;
        this.#disconnectingConnections.add(connection);
        await this.#settleTracked('failed to disconnect browser connection', () => connection.disconnect());
    }

    trackLate(task: Promise<void>): void {
        this.#lateTasks.add(task);
        void task.then(
            () => this.#lateTasks.delete(task),
            (error: unknown) => {
                this.#lateTasks.delete(task);
                this.#record('late browser cleanup failed', error instanceof Error ? error : String(error));
            },
        );
    }

    async awaitLateTasks(): Promise<void> {
        if (this.#lateTasks.size === 0) return;
        const tasks = [...this.#lateTasks];
        await this.settle('late browser cleanup did not settle', async () => {
            await Promise.allSettled(tasks);
        });
    }

    async waitForLateTasks(signal: AbortSignal): Promise<void> {
        this.#assertReusable();
        if (this.#lateTasks.size === 0) return;
        const pending = Promise.allSettled([...this.#lateTasks]).then(() => undefined);
        await raceBrowserOperation(pending, signal, 'previous browser resource cleanup');
        this.#assertReusable();
    }

    async settle(label: string, run: () => Promise<unknown>): Promise<void> {
        await this.#settleOperation(label, Promise.resolve().then(run));
    }

    async #settleTracked(label: string, run: () => Promise<unknown>): Promise<void> {
        const operation = Promise.resolve().then(run);
        this.#trackPending(operation);
        await this.#settleOperation(label, operation);
    }

    async #settleOperation(label: string, operation: Promise<unknown>): Promise<void> {
        try {
            await raceBrowserCleanup(operation, this.protocolTimeoutMs, label);
        } catch (error: unknown) {
            this.#record(label, error instanceof Error ? error : String(error));
        }
    }

    #trackPending(task: Promise<unknown>): void {
        const pending = task.then(
            () => undefined,
            (error: unknown) => {
                this.#cleanupFailed = true;
                throw error;
            },
        );
        this.#lateTasks.add(pending);
        void pending.then(
            () => this.#lateTasks.delete(pending),
            () => this.#lateTasks.delete(pending),
        );
    }

    #record(label: string, error: unknown): void {
        const detail = error instanceof Error ? error.message : String(error);
        if (this.#cleanupErrors.length === MAX_BROWSER_CLEANUP_ERRORS) this.#cleanupErrors.shift();
        this.#cleanupErrors.push(this.observabilityRedactor.redactText(`${label}: ${detail}`));
    }

    #assertReusable(): void {
        if (this.#cleanupFailed) throw browserFailure('previous browser resource cleanup failed');
    }
}
