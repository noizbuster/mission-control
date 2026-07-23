import type { AbgSignal, ProviderStreamChunk } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { wrapFlatProviderAsSdkModel } from '../../../providers/ai-sdk/flat-provider-bridge';
import { createDeterministicProvider } from '../../../providers/deterministic-provider';
import type {
    ProviderAdapter,
    ProviderAdapterContext,
    ProviderTurnRequest,
} from '../../../providers/provider-turn-types';
import { runLlmActor } from './llm-actor-node';
import { messages, NOW } from './llm-actor-node-test-support';

type RetryingTimeoutProvider = ProviderAdapter & {
    readonly attemptCount: () => number;
};

function createRetryingTimeoutProvider(): RetryingTimeoutProvider {
    let attempts = 0;
    return {
        async *streamTurn(
            request: ProviderTurnRequest,
            _context: ProviderAdapterContext,
        ): AsyncIterable<ProviderStreamChunk> {
            attempts += 1;
            if (attempts === 1) {
                yield {
                    kind: 'response_failed',
                    requestId: request.requestId,
                    sequence: 1,
                    error: {
                        code: 'provider_timeout',
                        message: 'first stream chunk timed out',
                        retryable: true,
                    },
                };
                return;
            }
            yield {
                kind: 'response_completed',
                requestId: request.requestId,
                sequence: 1,
                message: {
                    messageId: `message_${request.turnId}`,
                    role: 'assistant',
                    content: 'recovered',
                },
                finishReason: 'stop',
            };
        },
        attemptCount: () => attempts,
    };
}

function createPermanentlyTimedOutProvider(): RetryingTimeoutProvider {
    let attempts = 0;
    return {
        async *streamTurn(
            request: ProviderTurnRequest,
            _context: ProviderAdapterContext,
        ): AsyncIterable<ProviderStreamChunk> {
            attempts += 1;
            yield {
                kind: 'response_failed',
                requestId: request.requestId,
                sequence: 1,
                error: {
                    code: 'provider_timeout',
                    message: 'stream chunk timed out',
                    retryable: true,
                },
            };
        },
        attemptCount: () => attempts,
    };
}

describe('LLM actor chunk timeout', () => {
    it('classifies an AI SDK chunk deadline as a retryable provider timeout', async () => {
        // Given
        const model = wrapFlatProviderAsSdkModel({
            provider: createDeterministicProvider([
                { kind: 'wait', ms: 100 },
                { kind: 'response_completed', content: 'late response' },
            ]),
            providerID: 'zai-coding-plan',
            modelID: 'glm-5.2',
            retryLimit: 0,
        });
        const signals: AbgSignal[] = [];

        // When
        for await (const signal of runLlmActor({
            graphId: 'chunk-timeout-graph',
            nodeId: 'chunk-timeout-node',
            model,
            system: 'Classify a timeout.',
            messages,
            timeoutMs: 20,
            now: () => NOW,
        })) {
            signals.push(signal);
        }

        // Then
        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            error: { code: 'provider_timeout', retryable: true },
        });
    });

    it('preserves an explicit provider abort when no chunk deadline elapsed', async () => {
        const model = wrapFlatProviderAsSdkModel({
            provider: createDeterministicProvider([
                {
                    kind: 'response_failed',
                    error: {
                        code: 'provider_aborted',
                        message: 'provider aborted',
                        retryable: false,
                    },
                },
            ]),
            providerID: 'local',
            modelID: 'local-echo',
            retryLimit: 0,
        });
        const signals: AbgSignal[] = [];

        for await (const signal of runLlmActor({
            graphId: 'provider-abort-graph',
            nodeId: 'provider-abort-node',
            model,
            system: 'Observe an explicit abort.',
            messages,
            timeoutMs: 100,
            now: () => NOW,
        })) {
            signals.push(signal);
        }

        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            error: { code: 'provider_aborted', retryable: false },
        });
    });

    it('retries a no-output timeout with a longer chunk deadline', async () => {
        // Given
        const provider = createRetryingTimeoutProvider();
        const model = wrapFlatProviderAsSdkModel({
            provider,
            providerID: 'zai-coding-plan',
            modelID: 'glm-5.2',
            retryLimit: 0,
        });
        const signals: AbgSignal[] = [];

        // When
        for await (const signal of runLlmActor({
            graphId: 'provider-timeout-retry-graph',
            nodeId: 'provider-timeout-retry-node',
            model,
            system: 'Retry a timed out provider request.',
            messages,
            retryBaseDelayMs: 0,
            maxRetryDelayMs: 0,
            now: () => NOW,
        })) {
            signals.push(signal);
        }

        // Then
        expect(provider.attemptCount()).toBe(2);
        expect(signals).toContainEqual(
            expect.objectContaining({
                type: 'emit',
                event: expect.objectContaining({
                    type: 'llm.provider_wait',
                    payload: expect.objectContaining({ reason: 'provider_timeout', chunkTimeoutMs: 240_000 }),
                }),
            }),
        );
        expect(signals.at(-1)).toMatchObject({ type: 'success' });
    });

    it('bounds default no-output timeout retries', async () => {
        const provider = createPermanentlyTimedOutProvider();
        const model = wrapFlatProviderAsSdkModel({
            provider,
            providerID: 'zai-coding-plan',
            modelID: 'glm-5.2',
            retryLimit: 0,
        });
        const signals: AbgSignal[] = [];

        for await (const signal of runLlmActor({
            graphId: 'provider-timeout-bound-graph',
            nodeId: 'provider-timeout-bound-node',
            model,
            system: 'Bound provider timeout retries.',
            messages,
            retryBaseDelayMs: 0,
            maxRetryDelayMs: 0,
            now: () => NOW,
        })) {
            signals.push(signal);
        }

        expect(provider.attemptCount()).toBe(4);
        expect(
            signals.filter((signal) => signal.type === 'emit' && signal.event.type === 'llm.provider_wait'),
        ).toHaveLength(3);
        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            error: { code: 'provider_timeout', retryable: true },
        });
    });
});
