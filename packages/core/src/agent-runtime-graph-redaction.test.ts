import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AbgGraphSpec, AgentEvent } from '@mission-control/protocol';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { AgentRuntime } from './agent-runtime';
import { createCodingAgentGraph } from './behavior/coding-agent-graph';
import { createCodingAgentNodeRegistry } from './behavior/coding-agent-registry';
import { createObservabilityRedactor } from './providers/observability-redactor';

describe('AgentRuntime graph redaction', () => {
    it('redacts token-like graph identifiers from the public result and runtime event log', async () => {
        // Given
        const secret = ['sk', 'runtime', 'graphsecret123'].join('-');
        const runtime = new AgentRuntime({ useNative: false });
        const graph: AbgGraphSpec = {
            id: `runtime-${secret}`,
            entryNodeId: 'finish',
            nodes: [{ id: 'finish', kind: 'action' }],
            edges: [],
            rules: [],
            policies: [],
        };

        // When
        await runtime.start();
        const result = await runtime.runGraph(graph);
        const observable = JSON.stringify({ result, events: runtime.getEvents() });

        // Then
        expect(observable).toContain('[REDACTED_CREDENTIAL]');
        expect(observable).not.toContain(secret);
    });

    it('uses the constructor redactor for exact secrets in graph results and runtime events', async () => {
        // Given
        const secret = 'runtime_graph_exact_secret_123';
        const runtime = new AgentRuntime({
            useNative: false,
            observabilityRedactor: createObservabilityRedactor({ secrets: [secret] }),
        });
        const graph: AbgGraphSpec = {
            id: `runtime-${secret}`,
            entryNodeId: 'finish',
            nodes: [{ id: 'finish', kind: 'action' }],
            edges: [],
            rules: [],
            policies: [],
        };

        // When
        await runtime.start();
        const result = await runtime.runGraph(graph);
        const resultJson = JSON.stringify(result);
        const eventsJson = JSON.stringify(runtime.getEvents());

        // Then
        expect(result.graphId).toBe('runtime-[REDACTED_CREDENTIAL]');
        expect(resultJson).not.toContain(secret);
        expect(eventsJson).toContain('[REDACTED_CREDENTIAL]');
        expect(eventsJson).not.toContain(secret);
    });

    it('uses a per-call redactor when no constructor redactor is configured', async () => {
        // Given
        const callSecret = 'runtime_call_secret_456';
        const runtime = new AgentRuntime({ useNative: false });
        const graph: AbgGraphSpec = {
            id: `runtime-${callSecret}`,
            entryNodeId: 'finish',
            nodes: [{ id: 'finish', kind: 'action' }],
            edges: [],
            rules: [],
            policies: [],
        };

        // When
        await runtime.start();
        const result = await runtime.runGraph(graph, undefined, {
            observabilityRedactor: createObservabilityRedactor({ secrets: [callSecret] }),
        });
        const observable = JSON.stringify({ result, events: runtime.getEvents() });

        // Then
        expect(observable).toContain('[REDACTED_CREDENTIAL]');
        expect(observable).not.toContain(callSecret);
    });

    it('composes constructor and per-call redactors for graph results, events, and final messages', async () => {
        // Given
        const constructorSecret = 'runtime_constructor_secret_123';
        const callSecret = 'runtime_call_secret_456';
        const runtime = new AgentRuntime({
            useNative: false,
            observabilityRedactor: createObservabilityRedactor({ secrets: [constructorSecret] }),
        });
        const chunks: LanguageModelV3StreamPart[] = [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text_final' },
            {
                type: 'text-delta',
                id: 'text_final',
                delta: `keep-this-answer ${constructorSecret} ${callSecret}`,
            },
            { type: 'text-end', id: 'text_final' },
            {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: {
                    inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
                    outputTokens: { total: 4, text: 4, reasoning: 0 },
                },
            },
        ];
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'runtime-redaction',
            doStream: async () => ({ stream: convertArrayToReadableStream(chunks) }),
        });
        const graph = {
            ...createCodingAgentGraph({ model: { providerID: 'test', modelID: 'runtime-redaction' } }),
            id: `runtime-${constructorSecret}-${callSecret}`,
        } satisfies AbgGraphSpec;
        const emittedEvents: AgentEvent[] = [];
        const unsubscribe = runtime.onEvent((event) => {
            emittedEvents.push(event);
        });

        // When
        await runtime.start();
        const result = await runtime.runGraph(graph, undefined, {
            registry: createCodingAgentNodeRegistry(),
            resolveSdkModel: () => model,
            initialMessages: [{ role: 'user', content: 'return a redacted answer' }],
            observabilityRedactor: createObservabilityRedactor({ secrets: [callSecret] }),
        });
        const resultJson = JSON.stringify(result);
        const eventsJson = JSON.stringify(runtime.getEvents());
        const emittedJson = JSON.stringify(emittedEvents);
        unsubscribe();

        // Then
        expect(result.status).toBe('completed');
        expect(result.graphId).toBe('runtime-[REDACTED_CREDENTIAL]-[REDACTED_CREDENTIAL]');
        expect(resultJson).toContain('keep-this-answer');
        expect(resultJson).toContain('[REDACTED_CREDENTIAL]');
        expect(eventsJson).toContain('[REDACTED_CREDENTIAL]');
        expect(emittedJson).toContain('[REDACTED_CREDENTIAL]');
        expect(resultJson).not.toContain(constructorSecret);
        expect(resultJson).not.toContain(callSecret);
        expect(eventsJson).not.toContain(constructorSecret);
        expect(eventsJson).not.toContain(callSecret);
        expect(emittedJson).not.toContain(constructorSecret);
        expect(emittedJson).not.toContain(callSecret);
    });
});
