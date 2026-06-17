import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { describe, expect, it } from 'vitest';
import { createDeterministicProvider } from '../deterministic-provider.js';
import { FlatProviderBridgeError, wrapFlatProviderAsSdkModel } from './flat-provider-bridge.js';

/** Drive a model's doStream for a single user prompt and collect the emitted stream parts. */
async function collectStreamParts(
    model: ReturnType<typeof wrapFlatProviderAsSdkModel>,
    prompt: string,
): Promise<readonly LanguageModelV3StreamPart[]> {
    const result = await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: prompt }] }] });
    const parts: LanguageModelV3StreamPart[] = [];
    const reader = result.stream.getReader();
    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }
        if (value !== undefined) {
            parts.push(value);
        }
    }
    return parts;
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
        const model = wrapFlatProviderAsSdkModel({ provider, providerID: 'test', modelID: 'mock' });

        let caught: unknown;
        const reader = (
            await model.doStream({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'interrupt' }] }] })
        ).stream.getReader();
        try {
            while (true) {
                const { done } = await reader.read();
                if (done) {
                    break;
                }
            }
        } catch (error) {
            caught = error;
        }

        expect(caught).toBeInstanceOf(FlatProviderBridgeError);
        expect((caught as FlatProviderBridgeError).error).toMatchObject({ code: 'provider_aborted', retryable: true });
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
