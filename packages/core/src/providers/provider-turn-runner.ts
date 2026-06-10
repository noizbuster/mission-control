import type { AgentEventEnvelope, ProtocolError, ProviderStreamChunk } from '@mission-control/protocol';
import {
    eventForProviderChunk,
    redactProviderChunk,
    responseFailedChunk,
    responseStartedChunk,
} from './provider-turn-events.js';
import { closeProviderChunkIterator, nextProviderChunk } from './provider-turn-timeout.js';
import {
    ProviderTurnError,
    type ProviderTurnRunInput,
    type ProviderTurnRunnerOptions,
    type ProviderTurnRunResult,
} from './provider-turn-types.js';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_RETRY_LIMIT = 2;
const DEFAULT_TOOL_CALL_LOOP_LIMIT = 8;

export class ProviderTurnRunner {
    private readonly options: Required<
        Pick<ProviderTurnRunnerOptions, 'timeoutMs' | 'retryLimit' | 'toolCallLoopLimit'>
    >;
    private readonly provider: ProviderTurnRunnerOptions['provider'];
    private readonly now: () => string;
    private readonly createEventId: NonNullable<ProviderTurnRunnerOptions['createEventId']>;

    constructor(options: ProviderTurnRunnerOptions) {
        this.provider = options.provider;
        this.now = options.now ?? (() => new Date().toISOString());
        this.createEventId = options.createEventId ?? ((_event, sequence) => `provider_event_${sequence}`);
        this.options = {
            timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
            retryLimit: options.retryLimit ?? DEFAULT_RETRY_LIMIT,
            toolCallLoopLimit: options.toolCallLoopLimit ?? DEFAULT_TOOL_CALL_LOOP_LIMIT,
        };
    }

    async runTurn(input: ProviderTurnRunInput): Promise<ProviderTurnRunResult> {
        const state = createEmitterState(input.startSequence);
        const signal = input.signal ?? new AbortController().signal;
        const maxAttempts = this.options.retryLimit + 1;

        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const started = responseStartedChunk(input, attempt);
            await this.emitEnvelope(input, state, started, 'durable');
            const result = await this.runAttempt(input, signal, state, attempt);
            if (result.kind === 'completed') {
                await this.emitEnvelope(input, state, result.chunk, 'durable');
                return {
                    status: 'completed',
                    message: result.chunk.message,
                    attempts: attempt,
                    envelopes: state.durableEnvelopes,
                };
            }
            if (!result.error.retryable || attempt === maxAttempts) {
                await this.emitEnvelope(
                    input,
                    state,
                    responseFailedChunk(input, state.nextProviderSequence, result.error),
                    'durable',
                );
                return {
                    status: 'failed',
                    error: result.error,
                    attempts: attempt,
                    envelopes: state.durableEnvelopes,
                };
            }
        }

        const error = unknownProviderError('provider retry loop ended unexpectedly');
        return {
            status: 'failed',
            error,
            attempts: maxAttempts,
            envelopes: state.durableEnvelopes,
        };
    }

    private async runAttempt(
        input: ProviderTurnRunInput,
        signal: AbortSignal,
        state: ProviderEmitterState,
        attempt: number,
    ): Promise<ProviderAttemptResult> {
        let toolCallCount = 0;
        const attemptAbort = new AbortController();
        const removeOuterAbort = forwardAbort(signal, attemptAbort);
        let iterator: AsyncIterator<ProviderStreamChunk> | undefined;
        try {
            if (signal.aborted) {
                return { kind: 'failed', error: abortedProviderError() };
            }
            iterator = this.provider
                .streamTurn(input, { attempt, signal: attemptAbort.signal })
                [Symbol.asyncIterator]();
            while (true) {
                const next = await nextProviderChunk({
                    iterator,
                    signal: attemptAbort.signal,
                    timeoutMs: this.options.timeoutMs,
                    onTimeout: () => {
                        attemptAbort.abort();
                    },
                });
                if (next.done === true) {
                    break;
                }
                const chunk = redactProviderChunk(next.value);
                state.nextProviderSequence = Math.max(state.nextProviderSequence, chunk.sequence + 1);
                if (chunk.kind === 'response_completed') {
                    return { kind: 'completed', chunk };
                }
                if (chunk.kind === 'response_failed') {
                    return { kind: 'failed', error: chunk.error };
                }
                if (chunk.kind === 'tool_call_completed') {
                    toolCallCount += 1;
                    if (toolCallCount > this.options.toolCallLoopLimit) {
                        return { kind: 'failed', error: toolLoopLimitError(this.options.toolCallLoopLimit) };
                    }
                }
                await this.emitEnvelope(
                    input,
                    state,
                    chunk,
                    chunk.kind === 'tool_call_completed' ? 'durable' : 'ephemeral',
                );
            }
            return { kind: 'failed', error: unknownProviderError('provider stream ended before completion') };
        } catch (error: unknown) {
            return { kind: 'failed', error: normalizeProviderError(error, signal) };
        } finally {
            if (attemptAbort.signal.aborted && iterator !== undefined) {
                await closeProviderChunkIterator(iterator);
            }
            removeOuterAbort();
        }
    }

    private async emitEnvelope(
        input: ProviderTurnRunInput,
        state: ProviderEmitterState,
        chunk: ProviderStreamChunk,
        durability: 'durable' | 'ephemeral',
    ): Promise<void> {
        const createdAt = this.now();
        const event = eventForProviderChunk(input, chunk, createdAt);
        const sequence = durability === 'durable' ? state.nextDurableSequence : state.nextEphemeralSequence;
        const envelope: AgentEventEnvelope = {
            eventId: this.createEventId(event, sequence),
            sequence,
            createdAt,
            sessionId: input.sessionId,
            durability,
            event,
        };
        input.onEnvelope?.(envelope);
        await input.writeEnvelope?.(envelope);
        if (durability === 'durable') {
            state.durableEnvelopes = [...state.durableEnvelopes, envelope];
            state.nextDurableSequence += 1;
            return;
        }
        state.nextEphemeralSequence += 1;
    }
}

type ProviderAttemptResult =
    | {
          readonly kind: 'completed';
          readonly chunk: Extract<ProviderStreamChunk, { readonly kind: 'response_completed' }>;
      }
    | { readonly kind: 'failed'; readonly error: ProtocolError };

type ProviderEmitterState = {
    nextDurableSequence: number;
    nextEphemeralSequence: number;
    nextProviderSequence: number;
    durableEnvelopes: readonly AgentEventEnvelope[];
};

function createEmitterState(startSequence: number): ProviderEmitterState {
    return {
        nextDurableSequence: startSequence,
        nextEphemeralSequence: startSequence,
        nextProviderSequence: 1,
        durableEnvelopes: [],
    };
}

function normalizeProviderError(error: unknown, signal: AbortSignal): ProtocolError {
    if (error instanceof ProviderTurnError) {
        return error.error;
    }
    if (signal.aborted) {
        return abortedProviderError();
    }
    return unknownProviderError(error instanceof Error ? error.message : String(error));
}

function forwardAbort(source: AbortSignal, target: AbortController): () => void {
    if (source.aborted) {
        target.abort();
        return () => undefined;
    }
    const abort = () => {
        target.abort();
    };
    source.addEventListener('abort', abort, { once: true });
    return () => {
        source.removeEventListener('abort', abort);
    };
}

function abortedProviderError(): ProtocolError {
    return {
        code: 'provider_aborted',
        message: 'provider turn aborted',
        retryable: false,
    };
}

function toolLoopLimitError(limit: number): ProtocolError {
    return {
        code: 'tool_failed',
        message: `provider turn tool loop limit exceeded: ${limit}`,
        retryable: false,
    };
}

function unknownProviderError(message: string): ProtocolError {
    return {
        code: 'unknown',
        message,
        retryable: false,
    };
}
