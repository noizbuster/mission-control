import type { ProviderStreamChunk } from '@mission-control/protocol';
import { filePatchCall } from './desktop-session-commands-test-support.js';
import type { ProviderAdapter, ProviderTurnRequest } from './providers/provider-turn-types.js';

export type Deferred<T> = {
    readonly promise: Promise<T>;
    readonly resolve: (value: T) => void;
};

export function deferred<T>(): Deferred<T> {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

export function createAbortableProvider(input: {
    readonly requests: ProviderTurnRequest[];
    readonly started: Deferred<void>;
    readonly cleanupFinished: Deferred<void>;
    readonly markClosed: () => void;
    readonly captureSignal: (signal: AbortSignal) => void;
}): ProviderAdapter {
    return {
        streamTurn(request, context) {
            input.requests.push(request);
            input.captureSignal(context.signal);
            return {
                [Symbol.asyncIterator]() {
                    return {
                        next() {
                            input.started.resolve();
                            return new Promise<IteratorResult<ProviderStreamChunk>>(() => undefined);
                        },
                        async return() {
                            input.markClosed();
                            await input.cleanupFinished.promise;
                            return { done: true, value: undefined };
                        },
                    };
                },
            };
        },
    };
}

export function createReleasingProvider(
    requests: ProviderTurnRequest[],
    started: Deferred<void>,
    release: Deferred<void>,
): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            started.resolve();
            await release.promise;
            yield {
                kind: 'response_completed',
                requestId: request.requestId,
                sequence: 1,
                message: { messageId: `message_${request.turnId}`, role: 'assistant', content: 'desktop run done' },
                finishReason: 'stop',
            };
        },
    };
}

export function createBlockedThenContinuationProvider(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            if (requests.length === 1) {
                yield* blockedPatchTurn(request);
                return;
            }
            const toolResult = request.messages.find((message) => message.role === 'tool');
            yield {
                kind: 'response_completed',
                requestId: request.requestId,
                sequence: 1,
                message: {
                    messageId: 'assistant_after_owner_restart',
                    role: 'assistant',
                    content: `continued after ${toolResult?.status ?? 'missing'} tool result`,
                },
                finishReason: 'stop',
            };
        },
    };
}

export function requestMessageContents(request: ProviderTurnRequest | undefined): readonly string[] {
    return (
        request?.messages.flatMap((message) => {
            if (message.role === 'tool') {
                return [];
            }
            return [message.content];
        }) ?? []
    );
}

function* blockedPatchTurn(request: ProviderTurnRequest): Generator<ProviderStreamChunk> {
    const toolCall = filePatchCall(
        'call_patch_restart_owner',
        '.mission-control-owner-restart.txt',
        'owner restart approved',
    );
    if (toolCall.kind !== 'tool_call_completed') {
        throw new TypeError('expected file.patch tool call step');
    }
    yield {
        kind: 'tool_call_completed',
        requestId: request.requestId,
        sequence: 1,
        toolCall: {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            argumentsJson: toolCall.argumentsJson,
        },
    };
    yield {
        kind: 'response_completed',
        requestId: request.requestId,
        sequence: 2,
        message: {
            messageId: 'assistant_needs_owner_restart_patch',
            role: 'assistant',
            content: 'approval required',
            providerToolCalls: [
                {
                    providerID: 'local',
                    toolCallId: toolCall.toolCallId,
                    toolName: toolCall.toolName,
                    argumentsJson: toolCall.argumentsJson,
                },
            ],
        },
        finishReason: 'tool_calls',
    };
}
