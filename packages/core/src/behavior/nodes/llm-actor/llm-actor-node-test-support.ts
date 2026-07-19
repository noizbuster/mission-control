import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AbgSignal } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { z } from 'zod';
import { assembleSystemPrompt } from '../../../context/system-prompt';
import { ToolRegistry } from '../../../tools/tool-registry';
import type { ToolRegistration } from '../../../tools/tool-registry-types';
import { bridgeAdvertisementsToAiSdk, type PolicyGateFn } from './abg-tool-bridge';
import type { LlmActorModel } from './llm-actor-node';
import { runLlmActor } from './llm-actor-node';

export const NOW = '2026-06-16T00:00:00.000Z';
export const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
export const messages: ModelMessage[] = [{ role: 'user', content: 'please echo hi' }];

function buildUsage() {
    return {
        inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 6, text: 6, reasoning: 0 },
    };
}

export function eventTypes(signals: readonly AbgSignal[]): string[] {
    return signals
        .filter((signal): signal is Extract<AbgSignal, { type: 'emit' }> => signal.type === 'emit')
        .map((signal) => signal.event.type);
}

export function anthropicShapeChunks(): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'reasoning-start', id: 'r1' },
        { type: 'reasoning-delta', id: 'r1', delta: 'deciding to echo' },
        { type: 'reasoning-end', id: 'r1' },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'Calling echo.' },
        { type: 'text-end', id: 't1' },
        { type: 'tool-input-start', id: 'call_1', toolName: 'echo' },
        { type: 'tool-input-delta', id: 'call_1', delta: JSON.stringify({ text: 'hi' }) },
        { type: 'tool-input-end', id: 'call_1' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'echo', input: JSON.stringify({ text: 'hi' }) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: buildUsage() },
    ];
}

export function openaiShapeChunks(): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't' },
        { type: 'text-delta', id: 't', delta: 'Echoing.' },
        { type: 'text-end', id: 't' },
        { type: 'tool-input-start', id: 'call_a', toolName: 'echo' },
        { type: 'tool-input-delta', id: 'call_a', delta: JSON.stringify({ text: 'hi' }) },
        { type: 'tool-input-end', id: 'call_a' },
        { type: 'tool-call', toolCallId: 'call_a', toolName: 'echo', input: JSON.stringify({ text: 'hi' }) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: buildUsage() },
    ];
}

export function buildMockModel(
    provider: string,
    modelId: string,
    chunks: LanguageModelV3StreamPart[],
): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        provider,
        modelId,
        doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
    });
}

export const echoRegistration: ToolRegistration<{ text: string }, { text: string }> = {
    name: 'echo',
    description: 'Echo a string back to the model.',
    capabilityClasses: ['read'],
    parametersJsonSchema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
    },
    inputSchema: z.object({ text: z.string() }),
    outputSchema: z.object({ text: z.string() }),
    outputLimit: { maxModelOutputChars: 2000 },
    execute: async (input) => ({ text: input.text }),
    toModelOutput: (output) => output.text,
};

export function buildEchoTools(policyGate: PolicyGateFn): ReturnType<typeof bridgeAdvertisementsToAiSdk> {
    const registry = new ToolRegistry();
    const advertisement = registry.register(echoRegistration);
    return bridgeAdvertisementsToAiSdk(registry, [advertisement], { policyGate });
}

export async function collectSignals(
    model: LlmActorModel,
    tools: ReturnType<typeof buildEchoTools>,
): Promise<readonly AbgSignal[]> {
    const collected: AbgSignal[] = [];
    for await (const signal of runLlmActor({
        graphId: 'g1',
        nodeId: 'llm-1',
        model,
        system: assembleSystemPrompt(),
        messages,
        tools,
        now: () => NOW,
    })) {
        collected.push(signal);
    }
    return collected;
}
