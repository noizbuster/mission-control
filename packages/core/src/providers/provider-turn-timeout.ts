import type { ProviderStreamChunk } from '@mission-control/protocol';
import type { SessionControlEpoch } from '../runtime/session-control-cancellation';
import { ProviderTurnError } from './provider-turn-types';

export type ProviderChunkIterator = AsyncIterator<ProviderStreamChunk>;

const iteratorClosePromises = new WeakMap<ProviderChunkIterator, Promise<void>>();

export const DEFAULT_PROVIDER_CHUNK_TIMEOUT_MS = 120_000;
export const MAX_PROVIDER_CHUNK_TIMEOUT_MS = 600_000;

export function nextProviderChunkTimeoutMs(currentTimeoutMs: number): number {
    return Math.min(currentTimeoutMs * 2, MAX_PROVIDER_CHUNK_TIMEOUT_MS);
}

export type NextProviderChunkInput = {
    readonly iterator: ProviderChunkIterator;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly onTimeout?: () => Promise<void> | void;
    readonly controlEpoch?: SessionControlEpoch;
};

export function nextProviderChunk(input: NextProviderChunkInput): Promise<IteratorResult<ProviderStreamChunk>> {
    if (input.signal.aborted) {
        return Promise.reject(new ProviderTurnError(abortedError()));
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const timeout = setTimeout(() => {
            void failAndClose(new ProviderTurnError(timeoutError()), () => input.onTimeout?.(), input.iterator);
        }, input.timeoutMs);
        const abort = () => {
            void failAndClose(new ProviderTurnError(abortedError()), undefined, input.iterator);
        };
        const cleanup = () => {
            clearTimeout(timeout);
            input.signal.removeEventListener('abort', abort);
        };
        const fail = (error: unknown) => {
            if (settled) {
                return false;
            }
            settled = true;
            cleanup();
            reject(error);
            return true;
        };
        const failAndClose = async (
            error: unknown,
            beforeClose: (() => Promise<void> | void) | undefined,
            iterator: ProviderChunkIterator,
        ) => {
            if (!fail(error)) {
                return;
            }
            const beforeCloseResult = beforeClose?.();
            if (beforeCloseResult !== undefined) {
                await beforeCloseResult;
            }
            await closeProviderChunkIterator(iterator);
        };
        const succeed = (result: IteratorResult<ProviderStreamChunk>) => {
            if (settled) {
                return;
            }
            settled = true;
            cleanup();
            resolve(result);
        };

        input.signal.addEventListener('abort', abort, { once: true });
        input.iterator.next().then(succeed, fail);
    });
}

export function closeProviderChunkIterator(iterator: ProviderChunkIterator): Promise<void> {
    const existing = iteratorClosePromises.get(iterator);
    if (existing !== undefined) {
        return existing;
    }
    const closing = closeIterator(iterator);
    iteratorClosePromises.set(iterator, closing);
    return closing;
}

async function closeIterator(iterator: ProviderChunkIterator): Promise<void> {
    const close = iterator.return;
    if (close === undefined) {
        return;
    }
    try {
        await close.call(iterator);
    } catch {}
}

function abortedError() {
    return {
        code: 'provider_aborted' as const,
        message: 'provider turn aborted',
        retryable: false,
    };
}

function timeoutError() {
    return {
        code: 'provider_timeout' as const,
        message: 'provider turn timed out',
        retryable: true,
    };
}
