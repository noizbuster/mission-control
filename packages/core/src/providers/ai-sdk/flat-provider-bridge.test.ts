import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createDeterministicProvider } from '../deterministic-provider.js';
import type { ProviderAdapter } from '../provider-turn-types.js';
import { FlatProviderBridgeError, wrapFlatProviderAsSdkModel } from './flat-provider-bridge.js';

/** Drive a model's doStream for a single user prompt and collect the emitted stream parts. */
async function collectStreamParts(
    model: ReturnType<typeof wrapFlatProviderAsSdkModel>,
    prompt: string,
): Promise<readonly LanguageModelV3StreamPart[]> {
    const captured = await captureStream(model, prompt);
    if (captured.error !== undefined) {
        throw captured.error;
    }
    return captured.parts;
}

async function captureStream(
    model: ReturnType<typeof wrapFlatProviderAsSdkModel>,
    prompt: string,
    signal?: AbortSignal,
): Promise<{ readonly parts: readonly LanguageModelV3StreamPart[]; readonly error?: unknown }> {
    const result = await model.doStream({
        prompt: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
        ...(signal !== undefined ? { abortSignal: signal } : {}),
    });
    const parts: LanguageModelV3StreamPart[] = [];
    const reader = result.stream.getReader();
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }
            if (value !== undefined) {
                parts.push(value);
            }
        }
        return { parts };
    } catch (error) {
        return { parts, error };
    }
}

describe('wrapFlatProviderAsSdkModel', () => {
    it('drives a flat provider through doStream and re-encodes text + finish as SDK stream parts', async () => {
        const provider = createDeterministicProvider([
            { kind: 'text_delta', delta: 'hello graph' },
            { kind: 'response_completed', content: 'hello graph', finishReason: 'stop' },
        ]);
        const model = wrapFlatProviderAsSdkModel({ provider, providerID: 'test', modelID: 'mock' });
        const parts = await collectStreamParts(model, 'summarize');

        expect(parts.some((part) => part.type === 'stream-start')).toBe(true);
        expect(parts.some((part) => part.type === 'text-start')).toBe(true);
        expect(parts.some((part) => part.type === 'text-delta' && part.delta === 'hello graph')).toBe(true);
        expect(parts.some((part) => part.type === 'text-end')).toBe(true);
        const finish = parts.find((part) => part.type === 'finish');
        expect(finish).toMatchObject({ type: 'finish', finishReason: { unified: 'stop' } });
    });

    it('emits a tool-call sequence (input framing + tool-call) for a tool_call_completed chunk', async () => {
        const provider = createDeterministicProvider([
            {
                kind: 'tool_call_completed',
                toolCallId: 'call_1',
                toolName: 'file.read',
                argumentsJson: '{"path":"a.txt"}',
            },
            { kind: 'response_completed', content: '', finishReason: 'tool_calls' },
        ]);
        const model = wrapFlatProviderAsSdkModel({ provider, providerID: 'test', modelID: 'mock' });
        const parts = await collectStreamParts(model, 'deterministic patch');

        expect(parts.some((part) => part.type === 'tool-input-start' && part.toolName === 'file.read')).toBe(true);
        expect(parts.some((part) => part.type === 'tool-input-delta' && part.delta === '{"path":"a.txt"}')).toBe(true);
        expect(parts.some((part) => part.type === 'tool-call' && part.toolName === 'file.read')).toBe(true);
        expect(parts.some((part) => part.type === 'finish' && part.finishReason.unified === 'tool-calls')).toBe(true);
    });

    it('surfaces response_failed through the stream as a FlatProviderBridgeError carrying the original code', async () => {
        const provider = createDeterministicProvider([
            {
                kind: 'response_failed',
                error: { code: 'provider_aborted', message: 'provider aborted', retryable: true },
            },
        ]);
        const model = wrapFlatProviderAsSdkModel({
            provider,
            providerID: 'test',
            modelID: 'mock',
            retryLimit: 0,
        });

        const { error: caught } = await captureStream(model, 'interrupt');

        expect(caught).toBeInstanceOf(FlatProviderBridgeError);
        expect((caught as FlatProviderBridgeError).error).toMatchObject({ code: 'provider_aborted', retryable: true });
        expect((caught as FlatProviderBridgeError).retryExhausted).toBe(true);
    });

    it('retries retryable provider failures with flat-runner backoff before completing', async () => {
        // Given
        const provider = createDeterministicProvider([
            [
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'overloaded', retryable: true },
                },
            ],
            [
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'overloaded', retryable: true },
                },
            ],
            [{ kind: 'response_completed', content: 'recovered', finishReason: 'stop' }],
        ]);
        const delays: number[] = [];
        const model = wrapFlatProviderAsSdkModel({
            provider,
            providerID: 'test',
            modelID: 'mock',
            retryLimit: 2,
            retryBaseDelayMs: 1_000,
            retrySleep: async (delayMs) => {
                delays.push(delayMs);
            },
        });

        // When
        const parts = await collectStreamParts(model, 'recover');

        // Then
        expect(provider.attemptCount()).toBe(3);
        expect(delays).toEqual([1_000, 2_000]);
        expect(parts.some((part) => part.type === 'text-delta' && part.delta === 'recovered')).toBe(true);
        expect(parts.some((part) => part.type === 'finish' && part.finishReason.unified === 'stop')).toBe(true);
    });

    it('retries a premature EOF before any provider completion chunk', async () => {
        // Given
        const provider = createDeterministicProvider([
            [],
            [{ kind: 'response_completed', content: 'recovered after EOF', finishReason: 'stop' }],
        ]);
        const model = wrapFlatProviderAsSdkModel({
            provider,
            providerID: 'test',
            modelID: 'mock',
            retryLimit: 1,
        });

        // When
        const parts = await collectStreamParts(model, 'recover EOF');

        // Then
        expect(provider.attemptCount()).toBe(2);
        expect(parts.some((part) => part.type === 'text-delta' && part.delta === 'recovered after EOF')).toBe(true);
    });

    it('does not retry after partial output has escaped the provider attempt', async () => {
        // Given
        const provider = createDeterministicProvider([
            [
                { kind: 'text_delta', delta: 'partial-' },
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'overloaded', retryable: true },
                },
            ],
            [{ kind: 'response_completed', content: 'fresh', finishReason: 'stop' }],
        ]);
        const model = wrapFlatProviderAsSdkModel({ provider, providerID: 'test', modelID: 'mock', retryLimit: 1 });

        // When
        const captured = await captureStream(model, 'do not duplicate');

        // Then
        expect(provider.attemptCount()).toBe(1);
        expect(captured.parts.filter((part) => part.type === 'text-delta').map((part) => part.delta)).toEqual([
            'partial-',
        ]);
        expect(captured.error).toBeInstanceOf(FlatProviderBridgeError);
        expect((captured.error as FlatProviderBridgeError).retryExhausted).toBe(true);
    });

    it('does not retry after a tool call has escaped the provider attempt', async () => {
        // Given
        const provider = createDeterministicProvider([
            [
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'call_once',
                    toolName: 'file.write',
                    argumentsJson: '{"path":"a.txt","content":"x"}',
                },
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'overloaded', retryable: true },
                },
            ],
            [{ kind: 'response_completed', content: 'must not retry', finishReason: 'stop' }],
        ]);
        const model = wrapFlatProviderAsSdkModel({ provider, providerID: 'test', modelID: 'mock', retryLimit: 1 });

        // When
        const captured = await captureStream(model, 'do not duplicate tools');

        // Then
        expect(provider.attemptCount()).toBe(1);
        expect(captured.parts.filter((part) => part.type === 'tool-call')).toHaveLength(1);
        expect(captured.error).toBeInstanceOf(FlatProviderBridgeError);
    });

    it('aborts an in-flight provider attempt when its bridge timeout expires', async () => {
        // Given
        let providerSignal: AbortSignal | undefined;
        let iteratorCloseCalls = 0;
        const provider: ProviderAdapter = {
            streamTurn(_request, context) {
                providerSignal = context.signal;
                return {
                    [Symbol.asyncIterator]() {
                        return {
                            next: () => new Promise(() => undefined),
                            async return() {
                                iteratorCloseCalls += 1;
                                return { done: true, value: undefined };
                            },
                        };
                    },
                };
            },
        };
        const model = wrapFlatProviderAsSdkModel({
            provider,
            providerID: 'test',
            modelID: 'mock',
            retryLimit: 0,
            timeoutMs: 10,
        });

        // When
        const captured = await captureStream(model, 'time out');

        // Then
        expect(providerSignal?.aborted).toBe(true);
        expect(iteratorCloseCalls).toBe(1);
        expect(captured.error).toBeInstanceOf(FlatProviderBridgeError);
        expect((captured.error as FlatProviderBridgeError).error.code).toBe('provider_timeout');
    });

    it('surfaces timeout without waiting forever for a non-cooperative iterator close', async () => {
        // Given
        const provider: ProviderAdapter = {
            streamTurn() {
                return {
                    [Symbol.asyncIterator]() {
                        return {
                            next: () => new Promise(() => undefined),
                            return: () => new Promise(() => undefined),
                        };
                    },
                };
            },
        };
        const model = wrapFlatProviderAsSdkModel({
            provider,
            providerID: 'test',
            modelID: 'mock',
            retryLimit: 0,
            timeoutMs: 10,
        });

        // When
        const outcome = await Promise.race([
            captureStream(model, 'time out without close'),
            new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 100)),
        ]);

        // Then
        expect(outcome).not.toBe('hung');
        if (outcome !== 'hung') {
            expect(outcome.error).toBeInstanceOf(FlatProviderBridgeError);
            expect((outcome.error as FlatProviderBridgeError).error.code).toBe('provider_timeout');
        }
    });

    it.each([
        ['retryLimit', Number.POSITIVE_INFINITY],
        ['retryLimit', 1.5],
        ['timeoutMs', Number.NaN],
        ['retryBaseDelayMs', -1],
        ['maxRetryDelayMs', Number.POSITIVE_INFINITY],
    ] as const)('rejects invalid numeric retry option %s=%s', (name, value) => {
        const provider = createDeterministicProvider([]);

        expect(() =>
            wrapFlatProviderAsSdkModel({
                provider,
                providerID: 'test',
                modelID: 'mock',
                [name]: value,
            }),
        ).toThrow(RangeError);
    });

    it('does not construct another provider attempt when aborted during retry backoff', async () => {
        // Given
        const controller = new AbortController();
        const provider = createDeterministicProvider([
            [
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'overloaded', retryable: true },
                },
            ],
            [
                {
                    kind: 'response_failed',
                    error: { code: 'provider_rate_limited', message: 'overloaded', retryable: true },
                },
            ],
            [{ kind: 'response_completed', content: 'must not run', finishReason: 'stop' }],
        ]);
        const model = wrapFlatProviderAsSdkModel({
            provider,
            providerID: 'test',
            modelID: 'mock',
            retryLimit: 2,
            retrySleep: async () => {
                controller.abort();
            },
        });

        // When
        const captured = await captureStream(model, 'abort backoff', controller.signal);

        // Then
        expect(provider.attemptCount()).toBe(1);
        expect(captured.error).toBeInstanceOf(FlatProviderBridgeError);
        expect((captured.error as FlatProviderBridgeError).error.code).toBe('provider_aborted');
    });

    it('threads the flat usage totals into the SDK usage shape on completion', async () => {
        const provider = createDeterministicProvider([
            {
                kind: 'response_completed',
                content: 'done',
                finishReason: 'stop',
                usage: { inputTokens: 12, outputTokens: 7, totalTokens: 19 },
            },
        ]);
        const model = wrapFlatProviderAsSdkModel({ provider, providerID: 'test', modelID: 'mock' });
        const parts = await collectStreamParts(model, 'go');
        const finish = parts.find((part) => part.type === 'finish');
        expect(finish).toMatchObject({
            type: 'finish',
            usage: {
                inputTokens: { total: 12, noCache: 12, cacheRead: 0, cacheWrite: 0 },
                outputTokens: { total: 7, text: 7, reasoning: 0 },
            },
        });
    });

    it('does not support doGenerate (the graph path only streams)', async () => {
        const provider = createDeterministicProvider([]);
        const model = wrapFlatProviderAsSdkModel({ provider, providerID: 'test', modelID: 'mock' });
        await expect(model.doGenerate({ prompt: [] })).rejects.toThrow();
    });
});
