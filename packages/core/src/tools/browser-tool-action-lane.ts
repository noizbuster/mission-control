import { createBrowserAbortScope, raceBrowserOperation } from './browser-tool-deadline.js';
import { browserFailure } from './browser-tool-output.js';

export class BrowserActionLane {
    readonly #shutdownController = new AbortController();
    readonly #pendingOperations = new Set<Promise<unknown>>();
    #tail = Promise.resolve();
    #activeAbort: (() => void) | undefined;
    #closed = false;

    async run<T>(signal: AbortSignal, operation: (actionSignal: AbortSignal) => Promise<T>): Promise<T> {
        if (this.#closed) throw browserFailure('browser connection manager is closed');
        const gate = deferredVoid();
        const predecessor = this.#tail;
        this.#tail = predecessor.then(() => gate.promise);
        const scope = createBrowserAbortScope(AbortSignal.any([signal, this.#shutdownController.signal]));
        let ownsAction = false;
        try {
            await raceBrowserOperation(predecessor, scope.signal, 'browser action queue');
            await this.#waitForPendingOperations(scope.signal);
            if (this.#closed) throw browserFailure('browser connection manager is closed');
            this.#activeAbort = scope.abort;
            ownsAction = true;
            return await operation(scope.signal);
        } finally {
            if (ownsAction && this.#activeAbort === scope.abort) this.#activeAbort = undefined;
            scope.dispose();
            gate.resolve();
        }
    }

    raceOperation<T>(operation: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
        this.#pendingOperations.add(operation);
        void operation.then(
            () => this.#pendingOperations.delete(operation),
            () => this.#pendingOperations.delete(operation),
        );
        return raceBrowserOperation(operation, signal, label);
    }

    abortActive(): void {
        this.#activeAbort?.();
    }

    shutdown(): void {
        if (this.#closed) return;
        this.#closed = true;
        this.#shutdownController.abort();
        this.abortActive();
    }

    async drain(): Promise<void> {
        await this.#tail;
        await Promise.allSettled([...this.#pendingOperations]);
    }

    async #waitForPendingOperations(signal: AbortSignal): Promise<void> {
        if (this.#pendingOperations.size === 0) return;
        const pending = Promise.allSettled([...this.#pendingOperations]).then(() => undefined);
        await raceBrowserOperation(pending, signal, 'previous browser action');
    }
}

function deferredVoid(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolve: () => void = () => undefined;
    const promise = new Promise<void>((settle) => {
        resolve = settle;
    });
    return { promise, resolve };
}
