import type { ObservabilityRedactor } from '../providers/observability-redactor';
import { BrowserActionLane } from './browser-tool-action-lane';
import type { ResolvedBrowserToolOptions } from './browser-tool-contract';
import { createBrowserAbortScope, raceBrowserOperation } from './browser-tool-deadline';
import { redactBrowserToolError } from './browser-tool-error-redaction';
import { browserFailure } from './browser-tool-output';
import type { BrowserConnectionSeam, BrowserPageSeam } from './browser-tool-puppeteer';
import { BrowserResourceCleanup } from './browser-tool-resource-cleanup';
import { observableBrowserEndpoint } from './browser-tool-url';
import { ToolExecutionError } from './tool-registry-types';

type ActiveBrowserPage = {
    readonly connection: BrowserConnectionSeam;
    readonly page: BrowserPageSeam;
    readonly removeDisconnectListener: () => void;
};

type PageAcquisition = {
    readonly controller: AbortController;
    readonly promise: Promise<BrowserPageSeam>;
};

export class BrowserConnectionManager {
    readonly #cleanup: BrowserResourceCleanup;
    readonly #actions = new BrowserActionLane();
    #active: ActiveBrowserPage | undefined;
    #acquisition: PageAcquisition | undefined;
    #resetTask: Promise<void> | undefined;
    #closeTask: Promise<void> | undefined;
    #closed = false;

    constructor(private readonly options: ResolvedBrowserToolOptions) {
        this.#cleanup = new BrowserResourceCleanup(options.observabilityRedactor, options.protocolTimeoutMs);
    }

    async runExclusive<T>(signal: AbortSignal, operation: (actionSignal: AbortSignal) => Promise<T>): Promise<T> {
        return this.#actions.run(signal, async (actionSignal) => {
            await this.#cleanup.waitForLateTasks(actionSignal);
            return operation(actionSignal);
        });
    }

    raceAction<T>(operation: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
        return this.#actions.raceOperation(operation, signal, label);
    }

    async acquirePage(signal: AbortSignal, observabilityRedactor: ObservabilityRedactor): Promise<BrowserPageSeam> {
        if (signal.aborted) throw browserFailure('browser page acquisition aborted');
        if (this.#resetTask !== undefined) {
            await raceBrowserOperation(this.#resetTask, signal, 'browser page reset');
        }
        if (this.#closed) throw browserFailure('browser connection manager is closed');
        const active = this.#active;
        if (
            active !== undefined &&
            this.#cleanup.connectionIsLive(active.connection) &&
            this.#cleanup.pageIsReusable(active.page)
        ) {
            return active.page;
        }
        if (active !== undefined) {
            await this.#startReset(false);
            await this.#cleanup.waitForLateTasks(signal);
        }
        if (signal.aborted) throw browserFailure('browser page acquisition aborted');
        if (this.#closed) throw browserFailure('browser connection manager is closed');

        const acquisition = this.#acquisition ?? this.#startAcquisition(signal, observabilityRedactor);
        return raceBrowserOperation(acquisition.promise, signal, 'browser page acquisition');
    }

    reset(): Promise<void> {
        return this.#startReset(true);
    }

    close(): Promise<void> {
        if (this.#closeTask !== undefined) return this.#closeTask;
        this.#closed = true;
        this.#actions.shutdown();
        this.#closeTask = this.#finishClose();
        return this.#closeTask;
    }

    getCleanupErrors(): readonly string[] {
        return this.#cleanup.getErrors();
    }

    async #finishClose(): Promise<void> {
        await this.#startReset(true);
        await this.#cleanup.settle('browser actions did not stop during shutdown', () => this.#actions.drain());
        await this.#cleanup.awaitLateTasks();
    }

    #startAcquisition(parentSignal: AbortSignal, observabilityRedactor: ObservabilityRedactor): PageAcquisition {
        const scope = createBrowserAbortScope(parentSignal);
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (scope.signal.aborted) controller.abort();
        else scope.signal.addEventListener('abort', abort, { once: true });
        let acquisition: PageAcquisition;
        const promise = this.#createPage(controller.signal, observabilityRedactor).finally(() => {
            scope.signal.removeEventListener('abort', abort);
            scope.dispose();
            if (this.#acquisition === acquisition) this.#acquisition = undefined;
        });
        acquisition = { controller, promise };
        this.#acquisition = acquisition;
        return acquisition;
    }

    #startReset(abortAction: boolean): Promise<void> {
        if (abortAction) this.#actions.abortActive();
        if (this.#resetTask !== undefined) return this.#resetTask;
        let task: Promise<void>;
        task = this.#resetResources().finally(() => {
            if (this.#resetTask === task) this.#resetTask = undefined;
        });
        this.#resetTask = task;
        return task;
    }

    async #resetResources(): Promise<void> {
        const acquisition = this.#acquisition;
        const active = this.#active;
        this.#active = undefined;
        acquisition?.controller.abort();
        if (acquisition !== undefined) {
            await this.#cleanup.settle('browser page acquisition did not stop during reset', async () => {
                await Promise.allSettled([acquisition.promise]);
            });
        }
        if (active !== undefined) {
            await this.#cleanup.cleanup(active.connection, active.page, active.removeDisconnectListener);
        }
    }

    async #createPage(signal: AbortSignal, observabilityRedactor: ObservabilityRedactor): Promise<BrowserPageSeam> {
        const connection = await this.#connect(signal, observabilityRedactor);
        let page: BrowserPageSeam | undefined;
        let lateCleanup = false;
        try {
            const pendingPage = connection.newPage();
            try {
                page = await raceBrowserOperation(pendingPage, signal, 'browser page acquisition');
            } catch (error: unknown) {
                if (signal.aborted) {
                    lateCleanup = true;
                    await this.#cleanup.cleanup(connection, undefined);
                    this.#cleanup.trackLate(
                        pendingPage.then(
                            (latePage) => this.#cleanup.closePage(latePage),
                            () => undefined,
                        ),
                    );
                }
                throw error;
            }
            if (
                signal.aborted ||
                !this.#cleanup.connectionIsLive(connection) ||
                !this.#cleanup.pageIsReusable(page) ||
                this.#closed
            ) {
                throw browserFailure('browser page acquisition aborted');
            }
            let active: ActiveBrowserPage;
            const removeDisconnectListener = connection.onDisconnected?.(() => {
                if (this.#active === active) void this.reset();
            });
            active = {
                connection,
                page,
                removeDisconnectListener: removeDisconnectListener ?? (() => undefined),
            };
            this.#active = active;
            return page;
        } catch (error: unknown) {
            if (!lateCleanup) await this.#cleanup.cleanup(connection, page);
            if (error instanceof ToolExecutionError) {
                throw redactBrowserToolError(error, observabilityRedactor);
            }
            const detail = error instanceof Error ? error.message : String(error);
            throw browserFailure(observabilityRedactor.redactText(`failed to open a browser page: ${detail}`));
        }
    }

    async #connect(signal: AbortSignal, observabilityRedactor: ObservabilityRedactor): Promise<BrowserConnectionSeam> {
        let pendingConnection: Promise<BrowserConnectionSeam> | undefined;
        try {
            pendingConnection = this.options.connect(
                this.options.endpoint,
                {
                    protocolTimeoutMs: this.options.protocolTimeoutMs,
                    defaultViewport: this.options.defaultViewport,
                },
                signal,
            );
            return await raceBrowserOperation(pendingConnection, signal, 'browser connection');
        } catch (error: unknown) {
            if (signal.aborted && pendingConnection !== undefined) {
                this.#cleanup.trackLate(
                    pendingConnection.then(
                        (lateConnection) => this.#cleanup.cleanup(lateConnection, undefined),
                        () => undefined,
                    ),
                );
            }
            if (error instanceof ToolExecutionError) {
                throw redactBrowserToolError(error, observabilityRedactor);
            }
            const detail = error instanceof Error ? error.message : String(error);
            throw browserFailure(
                observabilityRedactor.redactText(
                    `failed to connect to Chrome CDP endpoint ${observableBrowserEndpoint(this.options.endpoint)}: ${detail}`,
                ),
            );
        }
    }
}
