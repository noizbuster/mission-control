// allow: SIZE_OK -- HEAD 327 -> current 347 pure LOC; one provider-turn retry, timeout, and tool-loop state machine.
import type { AgentEventEnvelope, ProtocolError, ProviderStreamChunk } from '@mission-control/protocol';
import {
    guardProviderChunkForObservability,
    redactProviderChunkForObservability,
} from './observability-provider-chunk';
import { createObservabilityRedactor, redactAgentEventEnvelopeForObservability } from './observability-redactor';
import {
    abortableRetrySleep,
    DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS,
    DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS,
    DEFAULT_PROVIDER_RETRY_LIMIT,
    providerRetryDelayMs,
    shouldContinueProviderRetry,
} from './provider-retry-policy';
import { createProviderStreamObservability } from './provider-stream-observability';
import { eventForProviderChunk, responseFailedChunk, responseStartedChunk } from './provider-turn-events';
import { closeProviderChunkIterator, nextProviderChunk } from './provider-turn-timeout';
import {
    ProviderTurnError,
    type ProviderTurnRunInput,
    type ProviderTurnRunnerOptions,
    type ProviderTurnRunResult,
} from './provider-turn-types';
import { retryAfterMsFromError } from './shared/retry-after';

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_TOOL_CALL_LOOP_LIMIT = 8;

export class ProviderTurnRunner {
    private readonly options: Required<
        Pick<
            ProviderTurnRunnerOptions,
            'timeoutMs' | 'retryLimit' | 'toolCallLoopLimit' | 'retryBaseDelayMs' | 'maxRetryDelayMs'
        >
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
            retryLimit: options.retryLimit ?? DEFAULT_PROVIDER_RETRY_LIMIT,
            toolCallLoopLimit: options.toolCallLoopLimit ?? DEFAULT_TOOL_CALL_LOOP_LIMIT,
            retryBaseDelayMs: options.retryBaseDelayMs ?? DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS,
            maxRetryDelayMs: options.maxRetryDelayMs ?? DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS,
        };
    }

    async runTurn(input: ProviderTurnRunInput): Promise<ProviderTurnRunResult> {
        const state = createEmitterState(input.startSequence);
        const observabilityRedactor = input.observabilityRedactor ?? createObservabilityRedactor();
        if (input.controlEpoch?.callbackFence !== undefined && input.writeEnvelope === undefined) {
            return quarantinedProviderResult(state, 0);
        }
        const signal = input.signal ?? new AbortController().signal;
        const maxAttempts = this.options.retryLimit + 1;

        for (let attempt = 1; ; attempt += 1) {
            const started = responseStartedChunk(input, attempt);
            await this.emitEnvelope(input, state, started, 'durable');
            const result = await this.runAttempt(input, signal, state, attempt);
            if (result.kind === 'completed') {
                // Redact once at the result boundary (mirrors the failed-path redact at :69).
                // The hot loop no longer pre-redacts every chunk; eventForProviderChunk is the
                // single source of truth for event redaction. The completed chunk is returned in
                // ProviderTurnRunResult.message, so its content must be redacted here too.
                // This double-redacts vs eventForProviderChunk, but only once per turn (idempotent).
                const completedChunk = redactProviderChunkForObservability(result.chunk, observabilityRedactor);
                if (completedChunk.kind !== 'response_completed') {
                    throw new TypeError(`Unexpected completed provider chunk kind: ${completedChunk.kind}`);
                }
                if (!(await this.emitEnvelope(input, state, completedChunk, 'durable'))) {
                    return quarantinedProviderResult(state, attempt);
                }
                // result.envelopes is the LIVE mutable ref of the per-turn state, not a frozen copy.
                // Safe to return directly: createEmitterState builds state fresh per runTurn, and once a
                // turn returns the state object is never mutated again. The public ProviderTurnRunResult
                // type still declares the field readonly, so callers cannot mutate it through the boundary.
                return {
                    status: 'completed',
                    message: completedChunk.message,
                    attempts: attempt,
                    envelopes: state.durableEnvelopes,
                };
            }
            const mayContinue =
                result.error.retryable &&
                shouldContinueProviderRetry({
                    error: result.error,
                    attempt,
                    maxAttempts,
                });
            if (!mayContinue) {
                const failedChunk = redactProviderChunkForObservability(
                    responseFailedChunk(input, state.nextProviderSequence, result.error),
                    observabilityRedactor,
                );
                if (failedChunk.kind !== 'response_failed') {
                    throw new TypeError(`Unexpected failed provider chunk kind: ${failedChunk.kind}`);
                }
                if (!(await this.emitEnvelope(input, state, failedChunk, 'durable'))) {
                    return quarantinedProviderResult(state, attempt);
                }
                return {
                    status: 'failed',
                    error: failedChunk.error,
                    attempts: attempt,
                    envelopes: state.durableEnvelopes,
                };
            }
            await sleepBeforeRetry(
                signal,
                attempt,
                this.options.retryBaseDelayMs,
                this.options.maxRetryDelayMs,
                result.error.retryAfterMs,
            );
            if (signal.aborted) {
                const failedChunk = redactProviderChunkForObservability(
                    responseFailedChunk(input, state.nextProviderSequence, abortedProviderError()),
                    observabilityRedactor,
                );
                if (failedChunk.kind !== 'response_failed') {
                    throw new TypeError(`Unexpected failed provider chunk kind: ${failedChunk.kind}`);
                }
                if (!(await this.emitEnvelope(input, state, failedChunk, 'durable'))) {
                    return quarantinedProviderResult(state, attempt);
                }
                return {
                    status: 'failed',
                    error: failedChunk.error,
                    attempts: attempt,
                    envelopes: state.durableEnvelopes,
                };
            }
        }
    }

    private async runAttempt(
        input: ProviderTurnRunInput,
        signal: AbortSignal,
        state: ProviderEmitterState,
        attempt: number,
    ): Promise<ProviderAttemptResult> {
        let toolCallCount = 0;
        const attemptAbort = new AbortController();
        const streamObservability = createProviderStreamObservability(
            input.observabilityRedactor ?? createObservabilityRedactor(),
        );
        const removeOuterAbort = forwardAbort(signal, attemptAbort);
        let iterator: AsyncIterator<ProviderStreamChunk> | undefined;
        try {
            if (signal.aborted) {
                return { kind: 'failed', error: abortedProviderError() };
            }
            iterator = this.provider
                .streamTurn(input, {
                    attempt,
                    signal: attemptAbort.signal,
                    ...(input.controlEpoch !== undefined ? { controlEpoch: input.controlEpoch } : {}),
                })
                [Symbol.asyncIterator]();
            while (true) {
                const next = await nextProviderChunk({
                    iterator,
                    signal: attemptAbort.signal,
                    timeoutMs: this.options.timeoutMs,
                    onTimeout: () => {
                        attemptAbort.abort();
                    },
                    ...(input.controlEpoch !== undefined ? { controlEpoch: input.controlEpoch } : {}),
                });
                if (next.done === true) {
                    break;
                }
                const guardedChunk = guardProviderChunkForObservability(next.value);
                for (const chunk of streamObservability.transform(guardedChunk)) {
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
            }
            return { kind: 'failed', error: unknownProviderError('provider stream ended before completion') };
        } catch (error: unknown) {
            return { kind: 'failed', error: normalizeProviderError(error, signal) };
        } finally {
            if (attemptAbort.signal.aborted && iterator !== undefined) {
                void closeProviderChunkIterator(iterator);
            }
            removeOuterAbort();
        }
    }

    private async emitEnvelope(
        input: ProviderTurnRunInput,
        state: ProviderEmitterState,
        chunk: ProviderStreamChunk,
        durability: 'durable' | 'ephemeral',
    ): Promise<boolean> {
        const createdAt = this.now();
        const observabilityRedactor = input.observabilityRedactor ?? createObservabilityRedactor();
        const observableChunk = redactProviderChunkForObservability(chunk, observabilityRedactor);
        const event = eventForProviderChunk(input, observableChunk, createdAt);
        const sequence = durability === 'durable' ? state.nextDurableSequence : state.nextEphemeralSequence;
        const envelope: AgentEventEnvelope = redactAgentEventEnvelopeForObservability(
            {
                eventId: this.createEventId(event, sequence),
                sequence,
                createdAt,
                sessionId: input.sessionId,
                durability,
                correlationId: input.requestId,
                event,
            },
            observabilityRedactor,
        );
        const observe = (): void => {
            input.onEnvelope?.(envelope);
            if (durability === 'durable') {
                state.durableEnvelopes.push(envelope);
                state.nextDurableSequence += 1;
                return;
            }
            state.nextEphemeralSequence += 1;
        };
        const publish = async (client?: import('@libsql/client').Client): Promise<void> => {
            await input.writeEnvelope?.(envelope, client);
            observe();
        };
        const fence = input.controlEpoch?.callbackFence;
        if (fence === undefined || (chunk.kind !== 'response_completed' && chunk.kind !== 'response_failed')) {
            await publish();
            return true;
        }
        const writeEnvelope = input.writeEnvelope;
        if (writeEnvelope === undefined) return false;
        const errorCode = chunk.kind === 'response_failed' ? chunk.error.code : undefined;
        const settlement = await fence.settle({
            handleKind: 'provider',
            handleId: `provider:${input.requestId}`,
            attemptedEventType: event.type,
            metadata: {
                status: chunk.kind === 'response_completed' ? 'completed' : 'failed',
                ...(errorCode !== undefined ? { errorCode } : {}),
                signalAborted: input.signal?.aborted ?? false,
            },
            write: (client) => writeEnvelope(envelope, client),
        });
        if (settlement.accepted) observe();
        return settlement.accepted;
    }
}

function quarantinedProviderResult(
    state: ProviderEmitterState,
    attempts: number,
): Extract<ProviderTurnRunResult, { readonly status: 'failed' }> {
    return {
        status: 'failed',
        error: abortedProviderError(),
        attempts,
        envelopes: state.durableEnvelopes,
    };
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
    durableEnvelopes: AgentEventEnvelope[];
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
    const message = error instanceof Error ? error.message : String(error);
    const retryAfterMs = retryAfterMsFromError(error);
    return {
        code: 'unknown',
        message,
        retryable: true,
        ...(retryAfterMs !== undefined ? { retryAfterMs } : {}),
    };
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

// Retryable: `unknown` is the carrier for transient network/stream drops (thrown fetch errors,
// premature stream close) — the case retries exist for. Finite retryLimit still bounds ordinary
// retryables; rate-limit / usage-exhaustion waits continue indefinitely until abort.
function unknownProviderError(message: string): ProtocolError {
    return {
        code: 'unknown',
        message,
        retryable: true,
    };
}

async function sleepBeforeRetry(
    signal: AbortSignal,
    attempt: number,
    baseMs: number,
    capMs: number,
    retryAfterMs: number | undefined,
): Promise<void> {
    const delay = providerRetryDelayMs({ attempt, baseMs, maxMs: capMs, retryAfterMs });
    await abortableRetrySleep(delay, signal);
}
