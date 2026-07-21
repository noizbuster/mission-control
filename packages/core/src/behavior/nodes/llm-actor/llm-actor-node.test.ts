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
import type { AbgSignal } from '@mission-control/protocol';
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { stepCountIs, streamText } from 'ai';
import { MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { assembleSystemPrompt } from '../../../context/system-prompt';
import { wrapFlatProviderAsSdkModel } from '../../../providers/ai-sdk/flat-provider-bridge';
import { createDeterministicProvider } from '../../../providers/deterministic-provider';
import type { PolicyGateFn } from './abg-tool-bridge';
import { runLlmActor } from './llm-actor-node';
import type { LlmActorModel } from './llm-actor-node';
import {
    anthropicShapeChunks,
    buildEchoTools,
    buildMockModel,
    collectSignals,
    eventTypes,
    messages,
    NOW,
    openaiShapeChunks,
    tick,
} from './llm-actor-node-test-support';

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

    it('emits provider_aborted without a second provider call when aborted during retry sleep', async () => {
        // Given
        let retrySleepCalls = 0;
        let retrySleepSignal: AbortSignal | undefined;
        const controller = new AbortController();
        const provider = createDeterministicProvider([
            {
                kind: 'response_failed',
                error: {
                    code: 'provider_rate_limited',
                    message: 'temporarily overloaded',
                    retryable: true,
                },
            },
        ]);
        const model = wrapFlatProviderAsSdkModel({
            provider,
            providerID: 'zai-coding-plan',
            modelID: 'glm-5.2',
            retryLimit: 0,
            retrySleep: async (_delayMs, signal) => {
                retrySleepCalls += 1;
                retrySleepSignal = signal;
                controller.abort();
            },
        });
        const tools = buildEchoTools(async () => ({ allowed: true }));
        const signals: AbgSignal[] = [];

        // When
        for await (const signal of runLlmActor({
            graphId: 'g1',
            nodeId: 'llm-1',
            model,
            system: assembleSystemPrompt(),
            messages,
            tools,
            signal: controller.signal,
            now: () => NOW,
        })) {
            signals.push(signal);
        }

        // Then
        expect(provider.attemptCount()).toBe(1);
        expect(retrySleepCalls).toBe(1);
        // AI SDK merges our abort signal with the chunk-timeout signal; verify state, not identity.
        expect(retrySleepSignal?.aborted).toBe(true);
        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            error: { code: 'provider_aborted' },
        });
        expect(signals.some((signal) => signal.type === 'success')).toBe(false);
        expect(eventTypes(signals)).toContain('llm.error');
    });

    it('marks a flat-provider retry exhaustion for the graph coordinator', async () => {
        // Given
        const provider = createDeterministicProvider([
            {
                kind: 'response_failed',
                error: {
                    code: 'provider_timeout',
                    message: 'provider timed out',
                    retryable: true,
                },
            },
        ]);
        const model = wrapFlatProviderAsSdkModel({
            provider,
            providerID: 'zai-coding-plan',
            modelID: 'glm-5.2',
            retryLimit: 0,
        });
        const tools = buildEchoTools(async () => ({ allowed: true }));

        // When
        const signals = await collectSignals(model, tools);

        // Then
        expect(signals.at(-1)).toMatchObject({
            type: 'failure',
            error: {
                code: 'provider_timeout',
                message: 'provider timed out',
                retryable: true,
                retryExhausted: true,
                providerError: true,
            },
        });
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

    it('suppresses the AI SDK v6 system-in-messages warning for runtime-authored system messages', async () => {
        const model = buildMockModel('openai', 'gpt-5', openaiShapeChunks());
        const tools = buildEchoTools(async () => ({ allowed: true }));
        const warnings: string[] = [];
        const originalWarn = console.warn;
        console.warn = (value: string) => {
            warnings.push(value);
        };
        try {
            const collected: AbgSignal[] = [];
            for await (const signal of runLlmActor({
                graphId: 'g1',
                nodeId: 'llm-1',
                model,
                system: assembleSystemPrompt(),
                messages: [
                    { role: 'system', content: 'runtime-injected reminder' },
                    ...messages,
                ],
                tools,
                now: () => NOW,
            })) {
                collected.push(signal);
            }
            const systemWarnings = warnings.filter((text) => text.includes('allowSystemInMessages'));
            expect(systemWarnings).toEqual([]);
            expect(collected.at(-1)).toMatchObject({ type: 'success' });
        } finally {
            console.warn = originalWarn;
        }
    });

    it('aborts a stalled provider stream via the chunk timeout', async () => {
        // Stalled stream: yields stream-start, then nothing — mirrors a hung SSE connection.
        // The stream errors itself when the SDK's merged abort signal fires (chunk timeout).
        const stalledModel: LlmActorModel = {
            specificationVersion: 'v3',
            provider: 'openai',
            modelId: 'gpt-5',
            supportedUrls: {},
            async doGenerate() {
                throw new Error('not used');
            },
            async doStream({ abortSignal }) {
                const stream = new ReadableStream<LanguageModelV3StreamPart>({
                    start(controller) {
                        controller.enqueue({ type: 'stream-start', warnings: [] });
                        // intentionally never enqueues again; closes only on abort
                        abortSignal?.addEventListener('abort', () => {
                            controller.error(new DOMException('aborted', 'AbortError'));
                        }, { once: true });
                    },
                });
                return { stream };
            },
        };
        const tools = buildEchoTools(async () => ({ allowed: true }));
        const start = Date.now();
        const collected: AbgSignal[] = [];
        for await (const signal of runLlmActor({
            graphId: 'g1',
            nodeId: 'llm-1',
            model: stalledModel,
            system: assembleSystemPrompt(),
            messages,
            tools,
            timeoutMs: 50,
            now: () => NOW,
        })) {
            collected.push(signal);
        }
        const elapsed = Date.now() - start;
        expect(elapsed).toBeLessThan(5_000);
        expect(collected.at(-1)).toMatchObject({ type: 'failure' });
        expect(collected.some((signal) => signal.type === 'success')).toBe(false);
    });
});
