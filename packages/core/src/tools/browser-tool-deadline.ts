import { browserFailure } from './browser-tool-output';

export const MAX_BROWSER_CLEANUP_TIMEOUT_MS = 1_000;

export type BrowserAbortScope = {
    readonly signal: AbortSignal;
    readonly abort: () => void;
    readonly dispose: () => void;
};

export function createBrowserAbortScope(parent: AbortSignal): BrowserAbortScope {
    const controller = new AbortController();
    const abort = () => controller.abort();
    if (parent.aborted) {
        controller.abort();
        return { signal: controller.signal, abort, dispose: () => undefined };
    }
    parent.addEventListener('abort', abort, { once: true });
    return {
        signal: controller.signal,
        abort,
        dispose: () => parent.removeEventListener('abort', abort),
    };
}

export function raceBrowserOperation<T>(operation: Promise<T>, signal: AbortSignal, label: string): Promise<T> {
    if (signal.aborted) {
        void operation.then(
            () => undefined,
            () => undefined,
        );
        return Promise.reject(browserFailure(`${label} aborted`));
    }
    return new Promise<T>((resolve, reject) => {
        const abort = () => {
            signal.removeEventListener('abort', abort);
            reject(browserFailure(`${label} aborted`));
        };
        signal.addEventListener('abort', abort, { once: true });
        void operation.then(
            (value) => {
                signal.removeEventListener('abort', abort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', abort);
                reject(error);
            },
        );
    });
}

export async function raceBrowserCleanup<T>(
    operation: Promise<T>,
    protocolTimeoutMs: number,
    label: string,
): Promise<T> {
    const controller = new AbortController();
    const timeoutMs = Math.max(1, Math.min(protocolTimeoutMs, MAX_BROWSER_CLEANUP_TIMEOUT_MS));
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await raceBrowserOperation(operation, controller.signal, label);
    } finally {
        clearTimeout(timeout);
    }
}
