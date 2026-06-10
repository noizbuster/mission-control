import type { ProviderStreamChunk } from '@mission-control/protocol';
import { ProviderTurnError } from './provider-turn-types.js';

export type ProviderChunkIterator = AsyncIterator<ProviderStreamChunk>;

export type NextProviderChunkInput = {
    readonly iterator: ProviderChunkIterator;
    readonly signal: AbortSignal;
    readonly timeoutMs: number;
    readonly onTimeout?: () => Promise<void> | void;
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
            await closeIterator(iterator);
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

export async function closeProviderChunkIterator(iterator: ProviderChunkIterator): Promise<void> {
    await closeIterator(iterator);
}

async function closeIterator(iterator: ProviderChunkIterator): Promise<void> {
    const close = iterator.return;
    if (close === undefined) {
        return;
    }
    await close.call(iterator).catch(() => undefined);
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
