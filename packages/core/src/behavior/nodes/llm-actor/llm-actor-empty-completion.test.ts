import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AbgSignal } from '@mission-control/protocol';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { assembleSystemPrompt } from '../../../context/system-prompt';
import { runLlmActor } from './llm-actor-node';
import { messages, NOW } from './llm-actor-node-test-support';

const usage = {
    inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 6, text: 6, reasoning: 0 },
};

function emptyCompletionChunks(): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
    ];
}

function textCompletionChunks(text: string): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: text },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
    ];
}

function reasoningOnlyChunks(): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'thought only' },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage },
    ];
}

function scriptedModel(calls: readonly LanguageModelV3StreamPart[][]): {
    readonly model: MockLanguageModelV3;
    readonly callCount: () => number;
} {
    let index = 0;
    const model = new MockLanguageModelV3({
        provider: 'test',
        modelId: 'test-model',
        doStream: async () => {
            const chunks = calls[Math.min(index, calls.length - 1)] ?? [];
            index += 1;
            return { stream: convertArrayToReadableStream(chunks) };
        },
    });
    return { model, callCount: () => index };
}

type LlmActorModel = Parameters<typeof runLlmActor>[0]['model'];

async function collectSignals(model: LlmActorModel): Promise<readonly AbgSignal[]> {
    const collected: AbgSignal[] = [];
    for await (const signal of runLlmActor({
        graphId: 'g1',
        nodeId: 'llm-empty',
        model,
        system: assembleSystemPrompt(),
        messages,
        now: () => NOW,
    })) {
        collected.push(signal);
    }
    return collected;
}

function providerWaitReasons(signals: readonly AbgSignal[]): string[] {
    return signals
        .filter(
            (signal): signal is Extract<AbgSignal, { type: 'emit' }> =>
                signal.type === 'emit' && signal.event.type === 'llm.provider_wait',
        )
        .map((signal) => {
            const payload = signal.event.payload as Readonly<Record<string, unknown>>;
            return typeof payload['reason'] === 'string' ? payload['reason'] : '';
        });
}

function successText(signals: readonly AbgSignal[]): string {
    const last = signals.at(-1);
    if (last === undefined || last.type !== 'success') {
        throw new Error(`expected terminal success signal, got ${last?.type ?? 'none'}`);
    }
    return (last.result as { readonly text: string }).text;
}

describe('llm-actor empty-completion recovery', () => {
    it('retries a zero-output completion and settles the retry text', async () => {
        // Given: the first stream completes with no visible parts, the second answers.
        const { model, callCount } = scriptedModel([emptyCompletionChunks(), textCompletionChunks('recovered')]);

        // When
        const signals = await collectSignals(model);

        // Then
        expect(callCount()).toBe(2);
        expect(providerWaitReasons(signals)).toEqual(['provider_empty_response']);
        expect(signals.at(-1)?.type).toBe('success');
        expect(successText(signals)).toContain('recovered');
    });

    it('bounds retries when every attempt completes empty', async () => {
        // Given: every stream completes with zero output.
        const { model, callCount } = scriptedModel([emptyCompletionChunks()]);

        // When
        const signals = await collectSignals(model);

        // Then: 3 retries after the first attempt, then an empty success settles.
        expect(callCount()).toBe(4);
        expect(providerWaitReasons(signals)).toHaveLength(3);
        expect(signals.at(-1)?.type).toBe('success');
        expect(successText(signals)).toBe('');
    });

    it('does not retry a reasoning-only response', async () => {
        // Given: the stream carries reasoning deltas but no text.
        const { model, callCount } = scriptedModel([reasoningOnlyChunks()]);

        // When
        const signals = await collectSignals(model);

        // Then: visible reasoning is a model choice, not a provider glitch.
        expect(callCount()).toBe(1);
        expect(providerWaitReasons(signals)).toEqual([]);
        expect(signals.at(-1)?.type).toBe('success');
    });
});
