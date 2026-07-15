import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AbgSignal } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createObservabilityRedactor } from '../../../providers/observability-redactor';
import { REDACTED_CREDENTIAL } from '../../../providers/redaction-handler';
import { ToolRegistry } from '../../../tools/tool-registry';
import { ToolExecutionError, type ToolRegistration } from '../../../tools/tool-registry-types';
import { bridgeAdvertisementsToAiSdk, createAbgToolSettlementLedger } from './abg-tool-bridge';
import { runLlmActor } from './llm-actor-node';

const NOW = '2026-07-13T00:00:00.000Z';

type ProbeInput = {
    readonly patch: string;
    readonly command: readonly string[];
    readonly headers: Readonly<Record<string, string>>;
};

type ProbeOutput = {
    readonly result: string;
    readonly nested: {
        readonly authorization: string;
        readonly ordinary: string;
    };
};

function buildUsage() {
    return {
        inputTokens: { total: 8, noCache: 8, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 12, text: 4, reasoning: 8 },
    };
}

function collectSecretBearingChunks(input: ProbeInput, reasoningSecret: string): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'reasoning-start', id: 'reasoning_1' },
        { type: 'reasoning-delta', id: 'reasoning_1', delta: `inspect ${reasoningSecret}` },
        { type: 'reasoning-end', id: 'reasoning_1' },
        { type: 'tool-input-start', id: 'call_probe', toolName: 'probe' },
        { type: 'tool-input-delta', id: 'call_probe', delta: JSON.stringify(input) },
        { type: 'tool-input-end', id: 'call_probe' },
        { type: 'tool-call', toolCallId: 'call_probe', toolName: 'probe', input: JSON.stringify(input) },
        { type: 'tool-input-start', id: 'call_fail', toolName: 'fail_probe' },
        { type: 'tool-input-delta', id: 'call_fail', delta: '{}' },
        { type: 'tool-input-end', id: 'call_fail' },
        { type: 'tool-call', toolCallId: 'call_fail', toolName: 'fail_probe', input: '{}' },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: buildUsage() },
    ];
}

describe('LLM actor observability redaction', () => {
    it('deep-redacts every signal copy while executing the original tool input', async () => {
        // Given
        const knownCredential = ['known', 'credential', 'value', '123'].join('_');
        const reasoningSecret = ['sk', 'reasoning', 'secret123'].join('-');
        const proposalSecret = ['sk', 'proposal', 'secret123'].join('-');
        const fallbackSecret = ['sk', 'fallback', 'secret123'].join('-');
        const toolErrorSecret = ['sk', 'toolerror', 'secret123'].join('-');
        const rawInput: ProbeInput = {
            patch: `*** Begin Patch\n+token=${proposalSecret}\n*** End Patch`,
            command: ['keep-this-command', '--token', knownCredential],
            headers: {
                Authorization: `Bearer ${knownCredential}`,
                'X-Api-Key': proposalSecret,
            },
        };
        let executedInput: ProbeInput | undefined;
        const probeRegistration: ToolRegistration<ProbeInput, ProbeOutput> = {
            name: 'probe',
            description: 'Capture a structured input and return a structured result.',
            capabilityClasses: ['read'],
            parametersJsonSchema: {
                type: 'object',
                properties: {
                    patch: { type: 'string' },
                    command: { type: 'array', items: { type: 'string' } },
                    headers: { type: 'object', additionalProperties: { type: 'string' } },
                },
                required: ['patch', 'command', 'headers'],
                additionalProperties: false,
            },
            inputSchema: z.object({
                patch: z.string(),
                command: z.array(z.string()),
                headers: z.record(z.string(), z.string()),
            }),
            outputSchema: z.object({
                result: z.string(),
                nested: z.object({ authorization: z.string(), ordinary: z.string() }),
            }),
            outputLimit: { maxModelOutputChars: 4_000 },
            execute: async (input) => {
                executedInput = input;
                return {
                    result: `provider fallback ${fallbackSecret}`,
                    nested: {
                        authorization: `Bearer ${knownCredential}`,
                        ordinary: 'keep-this-result',
                    },
                };
            },
            toModelOutput: (output) => JSON.stringify(output),
        };
        const failedRegistration: ToolRegistration<Record<string, never>, Record<string, never>> = {
            name: 'fail_probe',
            description: 'Return a typed tool failure.',
            capabilityClasses: ['read'],
            parametersJsonSchema: { type: 'object', properties: {}, additionalProperties: false },
            inputSchema: z.object({}).strict(),
            outputSchema: z.object({}).strict(),
            outputLimit: { maxModelOutputChars: 1_000 },
            execute: async () => {
                throw new ToolExecutionError({
                    code: 'tool_failed',
                    message: `nested tool failure ${toolErrorSecret} ${knownCredential}`,
                    retryable: false,
                });
            },
        };
        const registry = new ToolRegistry();
        const advertisements = [registry.register(probeRegistration), registry.register(failedRegistration)];
        const settlementLedger = createAbgToolSettlementLedger();
        const tools = bridgeAdvertisementsToAiSdk(registry, advertisements, { settlementLedger });
        const chunks = collectSecretBearingChunks(rawInput, reasoningSecret);
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'observability-redaction',
            doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
        });
        const messages: ModelMessage[] = [{ role: 'user', content: 'exercise redaction' }];
        const runInput = {
            graphId: 'graph_observability_redaction',
            nodeId: 'llm_actor',
            model,
            system: 'Run the proposed tools.',
            messages,
            tools,
            now: () => NOW,
            settlementLedger,
            observabilityRedactor: createObservabilityRedactor({ secrets: [knownCredential] }),
        };

        // When
        const signals: AbgSignal[] = [];
        for await (const signal of runLlmActor(runInput)) {
            signals.push(signal);
        }
        const observable = JSON.stringify(signals);

        // Then
        expect(executedInput).toEqual(rawInput);
        expect(observable.includes(REDACTED_CREDENTIAL)).toBe(true);
        expect(observable.includes('keep-this-command')).toBe(true);
        expect(observable.includes('keep-this-result')).toBe(true);
        for (const secret of [knownCredential, reasoningSecret, proposalSecret, fallbackSecret, toolErrorSecret]) {
            expect(observable.includes(secret)).toBe(false);
        }
    });

    it('withholds split credentials across every text and reasoning delta boundary', async () => {
        // Given
        const knownCredential = ['known', 'stream', 'credential', 'value'].join('_');
        const redactor = createObservabilityRedactor({ secrets: [knownCredential] });

        for (let split = 1; split < knownCredential.length; split += 1) {
            const left = knownCredential.slice(0, split);
            const right = knownCredential.slice(split);
            const chunks: LanguageModelV3StreamPart[] = [
                { type: 'stream-start', warnings: [] },
                { type: 'text-start', id: 'text_1' },
                { type: 'text-delta', id: 'text_1', delta: `visible ${left}` },
                { type: 'text-delta', id: 'text_1', delta: `${right} tail` },
                { type: 'text-end', id: 'text_1' },
                { type: 'reasoning-start', id: 'reasoning_1' },
                { type: 'reasoning-delta', id: 'reasoning_1', delta: `thinking ${left}` },
                { type: 'reasoning-delta', id: 'reasoning_1', delta: `${right} done` },
                { type: 'reasoning-end', id: 'reasoning_1' },
                { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: buildUsage() },
            ];
            const model = new MockLanguageModelV3({
                provider: 'test',
                modelId: `split-observability-${split}`,
                doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
            });
            const signals: AbgSignal[] = [];

            // When
            for await (const signal of runLlmActor({
                graphId: 'graph_split_observability',
                nodeId: 'llm_actor',
                model,
                system: 'Stream safely.',
                messages: [{ role: 'user', content: 'exercise split redaction' }],
                now: () => NOW,
                observabilityRedactor: redactor,
            })) {
                signals.push(signal);
            }

            // Then
            const text = joinedDelta(signals, 'llm.text.delta');
            const reasoning = joinedDelta(signals, 'llm.reasoning.delta');
            expect(text, `text split ${split}`).toBe(`visible ${REDACTED_CREDENTIAL} tail`);
            expect(reasoning, `reasoning split ${split}`).toBe(`thinking ${REDACTED_CREDENTIAL} done`);
            expect(JSON.stringify(signals).includes(knownCredential), `serialized split ${split}`).toBe(false);
        }
    });
});

function joinedDelta(signals: readonly AbgSignal[], eventType: string): string {
    return signals
        .flatMap((signal) => {
            if (signal.type !== 'emit' || signal.event.type !== eventType) {
                return [];
            }
            const payload = signal.event.payload;
            if (typeof payload !== 'object' || payload === null || !('delta' in payload)) {
                return [];
            }
            return typeof payload.delta === 'string' ? [payload.delta] : [];
        })
        .join('');
}
