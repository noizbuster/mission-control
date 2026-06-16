/**
 * Phase 0 gating spike + post-review fixes.
 *
 * Proves the keystone architecture and the review-driven fixes:
 *  1. LLMActor emits `started → (deltas/proposals) → success` from an AI SDK stream.
 *  2. §5.2 seam: a tool's `execute` awaits the ABG policy gate; the SDK does not continue
 *     the turn until the decision resolves.
 *  3. `stopWhen: stepCountIs(1)` is STRUCTURAL (no override): exactly one `doStream` call
 *     even when finish reason is `tool-calls`. Control: a 2-step budget makes the SDK loop.
 *  4. Stream error/abort -> `failure` + `llm.error` (no `success`) — terminal signal always reached.
 *  5. Failed tool settlements surface the error to the model (not '').
 *  6. Malformed parametersJsonSchema fails fast at bridge build.
 *  7. Adapter maps tool-error/tool-output-denied/error parts to ABG events.
 *
 * Two provider output shapes (Anthropic-style reasoning; OpenAI-style plain) at the
 * LanguageModelV3 layer — where the SDK's dispatch/loop-control behavior lives.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AbgSignal } from '@mission-control/protocol';
import type { ModelMessage, TextStreamPart, ToolSet } from 'ai';
import { stepCountIs, streamText } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { assembleSystemPrompt } from '../../../context/system-prompt.js';
import { ToolRegistry } from '../../../tools/tool-registry.js';
import type { ToolRegistration } from '../../../tools/tool-registry-types.js';
import {
    AbgToolBridgeError,
    bridgeAdvertisementsToAiSdk,
    bridgeAdvertisementToAiSdk,
    createAbgToolSettlementLedger,
    type PolicyGateFn,
} from './abg-tool-bridge.js';
import { abgSignalsFromStreamPart, type StreamPartAdapterContext } from './ai-sdk-adapter.js';
import { runLlmActor } from './llm-actor-node.js';

const NOW = '2026-06-16T00:00:00.000Z';
const tick = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function buildUsage() {
    return {
        inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 6, text: 6, reasoning: 0 },
    };
}

function eventTypes(signals: readonly AbgSignal[]): string[] {
    return signals
        .filter((signal): signal is Extract<AbgSignal, { type: 'emit' }> => signal.type === 'emit')
        .map((signal) => signal.event.type);
}

function anthropicShapeChunks(): LanguageModelV3StreamPart[] {
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

function openaiShapeChunks(): LanguageModelV3StreamPart[] {
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

function buildMockModel(provider: string, modelId: string, chunks: LanguageModelV3StreamPart[]): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        provider,
        modelId,
        doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
    });
}

const echoRegistration: ToolRegistration<{ text: string }, { text: string }> = {
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

function buildEchoTools(policyGate: PolicyGateFn): ReturnType<typeof bridgeAdvertisementsToAiSdk> {
    const registry = new ToolRegistry();
    const advertisement = registry.register(echoRegistration);
    return bridgeAdvertisementsToAiSdk(registry, [advertisement], { policyGate });
}

const messages: ModelMessage[] = [{ role: 'user', content: 'please echo hi' }];

async function collectSignals(
    model: MockLanguageModelV3,
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

describe('LLMActor node — Phase 0 gating spike', () => {
    it.each([
        ['anthropic-shape', 'anthropic', 'claude-fable-5', anthropicShapeChunks()],
        ['openai-shape', 'openai', 'gpt-5', openaiShapeChunks()],
    ])('emits started → deltas → success with exactly one model call (%s)', async (_label, provider, modelId, chunks) => {
        const model = buildMockModel(provider, modelId, chunks);
        const tools = buildEchoTools(async () => ({ allowed: true }));

        const signals = await collectSignals(model, tools);

        expect(signals[0]).toMatchObject({ type: 'started', nodeId: 'llm-1' });
        expect(signals.at(-1)).toMatchObject({ type: 'success', nodeId: 'llm-1' });

        const types = eventTypes(signals);
        expect(types).toContain('llm.turn.started');
        expect(types).toContain('llm.text.delta');
        expect(types).toContain('llm.tool_call.proposed');
        expect(types).toContain('tool.completed');
        expect(types).toContain('llm.turn.completed');
        if (provider === 'anthropic') {
            expect(types).toContain('llm.reasoning.delta');
        }

        // keystone (structural): exactly ONE model call despite finish reason 'tool-calls'
        expect(model.doStreamCalls.length).toBe(1);
    });

    it('policy gate blocks tool execution until the decision resolves (§5.2 seam)', async () => {
        const model = buildMockModel('anthropic', 'claude-fable-5', anthropicShapeChunks());

        let gateInvoked = false;
        let resolvePolicy: () => void = () => undefined;
        const policyPromise = new Promise<void>((resolve) => {
            resolvePolicy = resolve;
        });
        const policyGate: PolicyGateFn = async () => {
            gateInvoked = true;
            await policyPromise;
            return { allowed: true };
        };
        const tools = buildEchoTools(policyGate);

        const signals: AbgSignal[] = [];
        const iterator = runLlmActor({
            graphId: 'g1',
            nodeId: 'llm-1',
            model,
            system: assembleSystemPrompt(),
            messages,
            tools,
            now: () => NOW,
        });
        const done = (async () => {
            for await (const signal of iterator) signals.push(signal);
        })();

        await tick(25);
        expect(gateInvoked).toBe(true);
        expect(eventTypes(signals)).toContain('llm.tool_call.proposed');
        // turn must NOT complete while the policy decision is pending
        expect(signals.some((signal) => signal.type === 'success')).toBe(false);
        expect(model.doStreamCalls.length).toBe(1);

        resolvePolicy();
        await done;

        expect(signals.some((signal) => signal.type === 'success')).toBe(true);
        expect(eventTypes(signals)).toContain('tool.completed');
        expect(model.doStreamCalls.length).toBe(1);
    });

    it('emits failure + llm.error (not success) when the stream errors', async () => {
        const model = new MockLanguageModelV3({
            provider: 'anthropic',
            modelId: 'claude-fable-5',
            doStream: async () => {
                throw new Error('provider 500');
            },
        });
        const tools = buildEchoTools(async () => ({ allowed: true }));

        const signals: AbgSignal[] = [];
        for await (const signal of runLlmActor({
            graphId: 'g1',
            nodeId: 'llm-1',
            model,
            system: assembleSystemPrompt(),
            messages,
            tools,
            now: () => NOW,
        })) {
            signals.push(signal);
        }

        expect(signals.some((signal) => signal.type === 'failure')).toBe(true);
        expect(signals.some((signal) => signal.type === 'success')).toBe(false);
        expect(eventTypes(signals)).toContain('llm.error');
    });

    it('control: a 2-step budget makes the SDK loop (why stepCountIs(1) is the keystone)', async () => {
        const model = buildMockModel('openai', 'gpt-5', openaiShapeChunks());
        const tools = buildEchoTools(async () => ({ allowed: true }));

        const result = streamText({ model, system: 's', messages, tools, stopWhen: stepCountIs(2) });
        for await (const _part of result.fullStream) {
            // drain to completion
        }
        // Without the stepCountIs(1) constraint the SDK runs its own loop -> 2 model calls.
        expect(model.doStreamCalls.length).toBe(2);
    });
});

describe('ai-sdk-adapter', () => {
    const ctx: StreamPartAdapterContext = { graphId: 'g1', nodeId: 'llm-1', now: () => NOW };

    it('maps stream parts to ABG events', () => {
        const textOut = abgSignalsFromStreamPart(
            { type: 'text-delta', id: 't', text: 'hi' } as TextStreamPart<ToolSet>,
            ctx,
        );
        expect(eventTypes(textOut)).toEqual(['llm.text.delta']);

        const toolCallOut = abgSignalsFromStreamPart(
            { type: 'tool-call', toolCallId: 'c', toolName: 'echo', input: '{}' } as TextStreamPart<ToolSet>,
            ctx,
        );
        expect(eventTypes(toolCallOut)).toEqual(['llm.tool_call.proposed']);

        const toolResultOut = abgSignalsFromStreamPart(
            { type: 'tool-result', toolCallId: 'c', toolName: 'echo', output: 'ok' } as TextStreamPart<ToolSet>,
            ctx,
        );
        expect(eventTypes(toolResultOut)).toEqual(['tool.completed']);
    });

    it('maps tool-error and tool-output-denied to ABG events (review fix #3)', () => {
        const toolErrorOut = abgSignalsFromStreamPart(
            { type: 'tool-error', toolCallId: 'c', toolName: 'echo' } as TextStreamPart<ToolSet>,
            ctx,
        );
        expect(eventTypes(toolErrorOut)).toEqual(['tool.failed']);

        const deniedOut = abgSignalsFromStreamPart(
            { type: 'tool-output-denied', toolCallId: 'c', toolName: 'echo' } as TextStreamPart<ToolSet>,
            ctx,
        );
        expect(eventTypes(deniedOut)).toEqual(['tool.denied']);
    });

    it('maps the error part via errorToString (review fix #8)', () => {
        const out = abgSignalsFromStreamPart(
            { type: 'error', error: new Error('boom') } as TextStreamPart<ToolSet>,
            ctx,
        );
        expect(eventTypes(out)).toEqual(['llm.error']);
        const event = out[0];
        if (event?.type !== 'emit') throw new Error('expected emit');
        expect((event.event.payload as { error: string }).error).toBe('boom');
    });

    it('recovers a failed settlement from the ledger so tool-result maps to tool.failed (not completed)', () => {
        // The SDK emits a `tool-result` (not `tool-error`) for a failed settlement because the
        // bridge surfaces failures to the model as a string. Without the ledger the adapter would
        // mislabel it `completed`; the ledger restores the true `failed` status + structured error.
        const ledger = createAbgToolSettlementLedger();
        ledger.record({
            toolCallId: 'c',
            toolName: 'echo',
            status: 'failed',
            error: { code: 'tool_failed', message: 'echo blew up', retryable: false },
        });
        const out = abgSignalsFromStreamPart(
            {
                type: 'tool-result',
                toolCallId: 'c',
                toolName: 'echo',
                output: 'Tool "echo" failed (tool_failed): echo blew up',
            } as TextStreamPart<ToolSet>,
            { ...ctx, settlementLedger: ledger },
        );
        expect(eventTypes(out)).toEqual(['tool.failed']);
        const event = out[0];
        if (event?.type !== 'emit') throw new Error('expected emit');
        expect((event.event.payload as { error: { code: string } }).error.code).toBe('tool_failed');
    });

    it('carries the settlement output on tool.completed and falls back to part.output without a ledger', () => {
        const ledger = createAbgToolSettlementLedger();
        ledger.record({ toolCallId: 'c', toolName: 'echo', status: 'completed', output: 'echoed: hi' });
        const withLedger = abgSignalsFromStreamPart(
            {
                type: 'tool-result',
                toolCallId: 'c',
                toolName: 'echo',
                output: 'model-facing string',
            } as TextStreamPart<ToolSet>,
            { ...ctx, settlementLedger: ledger },
        );
        expect(eventTypes(withLedger)).toEqual(['tool.completed']);
        const ledgerEvent = withLedger[0];
        if (ledgerEvent?.type !== 'emit') throw new Error('expected emit');
        // The ledger's settlement output (the parity value) wins over the SDK's model-facing string.
        expect((ledgerEvent.event.payload as { output: unknown }).output).toBe('echoed: hi');

        // No ledger -> fall back to the part's own output (unchanged pre-enrichment shape).
        const withoutLedger = abgSignalsFromStreamPart(
            {
                type: 'tool-result',
                toolCallId: 'c',
                toolName: 'echo',
                output: 'fallback output',
            } as TextStreamPart<ToolSet>,
            ctx,
        );
        const fallbackEvent = withoutLedger[0];
        if (fallbackEvent?.type !== 'emit') throw new Error('expected emit');
        expect((fallbackEvent.event.payload as { output: unknown }).output).toBe('fallback output');
    });

    it('coerces a tool-error part into a tool.failed ProtocolError', () => {
        const out = abgSignalsFromStreamPart(
            {
                type: 'tool-error',
                toolCallId: 'c',
                toolName: 'echo',
                error: new Error('execute threw'),
            } as TextStreamPart<ToolSet>,
            ctx,
        );
        expect(eventTypes(out)).toEqual(['tool.failed']);
        const event = out[0];
        if (event?.type !== 'emit') throw new Error('expected emit');
        expect((event.event.payload as { error: { code: string; message: string } }).error).toEqual({
            code: 'unknown',
            message: 'execute threw',
            retryable: false,
        });
    });
});

describe('abg-tool-bridge', () => {
    it('surfaces failed-settlement errors to the model instead of "" (review fix #2)', async () => {
        const registry = new ToolRegistry();
        const advertisement = registry.register(echoRegistration);
        const bridged = bridgeAdvertisementToAiSdk(registry, advertisement, {});
        if (bridged.execute === undefined) {
            throw new Error('bridged tool is missing execute');
        }
        // { wrong: 1 } fails echo's z.object({ text: z.string() }) -> schema_invalid settlement
        const result = await bridged.execute(
            { wrong: 1 },
            { toolCallId: 'c1', messages: [] as ModelMessage[], abortSignal: new AbortController().signal },
        );
        expect(result).toContain('failed (schema_invalid)');
    });

    it('rejects a malformed parametersJsonSchema at bridge build time (review fix #5)', () => {
        const registry = new ToolRegistry();
        const advertisement = registry.register({
            ...echoRegistration,
            name: 'bad-schema',
            parametersJsonSchema: { notASchema: true },
        });
        expect(() => bridgeAdvertisementToAiSdk(registry, advertisement, {})).toThrow(AbgToolBridgeError);
    });

    it('records the settlement outcome in the ledger (status/output/error parity for the tool emits)', async () => {
        const registry = new ToolRegistry();
        const advertisement = registry.register(echoRegistration);
        const ledger = createAbgToolSettlementLedger();
        const bridged = bridgeAdvertisementToAiSdk(registry, advertisement, { settlementLedger: ledger });
        if (bridged.execute === undefined) throw new Error('bridged tool missing execute');

        // completed: echo({ text: 'hi' }) settles completed with an output the adapter will carry.
        await bridged.execute(
            { text: 'hi' },
            { toolCallId: 'c_ok', messages: [] as ModelMessage[], abortSignal: new AbortController().signal },
        );
        const completed = ledger.lookup('c_ok');
        expect(completed?.status).toBe('completed');
        expect(completed?.output).not.toBeUndefined();

        // failed: { wrong: 1 } fails echo's input zod schema -> schema_invalid settlement.
        await bridged.execute(
            { wrong: 1 },
            { toolCallId: 'c_bad', messages: [] as ModelMessage[], abortSignal: new AbortController().signal },
        );
        const failed = ledger.lookup('c_bad');
        expect(failed?.status).toBe('failed');
        expect(failed?.error?.code).toBe('schema_invalid');
    });

    it('records a denied policy gate as a failed settlement so the emit is not mislabeled completed', async () => {
        const registry = new ToolRegistry();
        const advertisement = registry.register(echoRegistration);
        const ledger = createAbgToolSettlementLedger();
        const deny: PolicyGateFn = async () => ({ allowed: false, reason: 'not permitted' });
        const bridged = bridgeAdvertisementToAiSdk(registry, advertisement, {
            policyGate: deny,
            settlementLedger: ledger,
        });
        if (bridged.execute === undefined) throw new Error('bridged tool missing execute');

        const result = await bridged.execute(
            { text: 'hi' },
            { toolCallId: 'c_deny', messages: [] as ModelMessage[], abortSignal: new AbortController().signal },
        );
        expect(result).toContain('BLOCKED');
        const entry = ledger.lookup('c_deny');
        expect(entry?.status).toBe('failed');
        expect(entry?.error?.code).toBe('unknown');
    });
});
