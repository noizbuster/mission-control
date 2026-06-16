/**
 * Phase 1 acceptance: the coding-agent graph runs the Observe→Decide→Act loop end-to-end
 * through REAL nodes against a step-aware scripted provider.
 *
 * Proves the keystone of Phase 1: with `stopWhen: stepCountIs(1)` (pinned in runLlmActor),
 * the GRAPH owns the loop. Step 1 the model proposes a tool → the bridge executes it →
 * the LLMActor node appends the response messages to the Blackboard and sets
 * `llm.loop_active` → the rule-gated self-edge re-enters. Step 2 the model emits a final
 * answer (no tool) → `llm.loop_active` is false → the edge does not fire → the graph
 * completes. Exactly 2 model calls, a full llm and tool event stream, no double loop.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AgentEvent } from '@mission-control/protocol';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ToolRegistry } from '../tools/tool-registry.js';
import type { ToolRegistration } from '../tools/tool-registry-types.js';
import { createCodingAgentGraph } from './coding-agent-graph.js';
import { createCodingAgentNodeRegistry } from './coding-agent-registry.js';
import { runAbgGraph } from './graph-runner.js';

const NOW = '2026-06-16T00:00:00.000Z';
const MODEL_SELECTION = { providerID: 'anthropic', modelID: 'claude-fable-5' } as const;

function buildUsage() {
    return {
        inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 6, text: 6, reasoning: 0 },
    };
}

/** Step 1: the model proposes the `echo` tool. */
function toolCallChunks(): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
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

/** Step 2: the model emits a final answer with no tool call. */
function finalTextChunks(): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't2' },
        { type: 'text-delta', id: 't2', delta: 'Done. Echoed hi.' },
        { type: 'text-end', id: 't2' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: buildUsage() },
    ];
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

function buildStepAwareModel(): MockLanguageModelV3 {
    let callCount = 0;
    return new MockLanguageModelV3({
        provider: MODEL_SELECTION.providerID,
        modelId: MODEL_SELECTION.modelID,
        doStream: async () => {
            callCount += 1;
            const chunks = callCount === 1 ? toolCallChunks() : finalTextChunks();
            return { stream: convertArrayToReadableStream(chunks) };
        },
    });
}

/** Step 1 proposes the tool; every subsequent call errors (simulating a provider 500). */
function buildErrorAfterToolModel(): MockLanguageModelV3 {
    let callCount = 0;
    return new MockLanguageModelV3({
        provider: MODEL_SELECTION.providerID,
        modelId: MODEL_SELECTION.modelID,
        doStream: async () => {
            callCount += 1;
            if (callCount === 1) {
                return { stream: convertArrayToReadableStream(toolCallChunks()) };
            }
            throw new Error('provider 500');
        },
    });
}

function emittedEventTypes(events: readonly AgentEvent[]): string[] {
    const types: string[] = [];
    for (const event of events) {
        if (event.type === 'log' && event.message !== undefined) {
            const match = event.message.match(/event: (.+)$/);
            if (match !== null) {
                const eventType = match[1];
                if (eventType !== undefined) {
                    types.push(eventType);
                }
            }
        }
    }
    return types;
}

describe('coding-agent graph — Observe → Decide → Act loop', () => {
    it('runs a multi-step tool-then-finalize task through real nodes with exactly two model calls', async () => {
        const model = buildStepAwareModel();
        const toolRegistry = new ToolRegistry();
        toolRegistry.register(echoRegistration);

        const result = await runAbgGraph({
            graph: createCodingAgentGraph({ model: MODEL_SELECTION }),
            sessionId: 'session_coding_agent_loop',
            now: () => NOW,
            modelProviderSelection: MODEL_SELECTION,
            registry: createCodingAgentNodeRegistry(),
            resolveSdkModel: () => model,
            toolRegistry,
            initialMessages: [{ role: 'user', content: 'echo hi then finish' }],
        });

        // The loop ran: step 1 proposed+executed the tool, step 2 produced the final answer.
        expect(result.status).toBe('completed');
        expect(model.doStreamCalls.length).toBe(2);

        const types = emittedEventTypes(result.events);
        // Step 1 signals: the model proposed a tool and the bridge executed it.
        expect(types).toContain('llm.tool_call.proposed');
        expect(types).toContain('tool.completed');
        // Two completed turns (one per graph-driven step).
        expect(types.filter((type) => type === 'llm.turn.completed').length).toBe(2);
    });

    it('completes in one step when the model emits no tool calls (loop never re-enters)', async () => {
        const model = new MockLanguageModelV3({
            provider: MODEL_SELECTION.providerID,
            modelId: MODEL_SELECTION.modelID,
            doStream: async () => ({ stream: convertArrayToReadableStream(finalTextChunks()) }),
        });
        const toolRegistry = new ToolRegistry();
        toolRegistry.register(echoRegistration);

        const result = await runAbgGraph({
            graph: createCodingAgentGraph({ model: MODEL_SELECTION }),
            sessionId: 'session_coding_agent_single',
            now: () => NOW,
            modelProviderSelection: MODEL_SELECTION,
            registry: createCodingAgentNodeRegistry(),
            resolveSdkModel: () => model,
            toolRegistry,
            initialMessages: [{ role: 'user', content: 'just answer' }],
        });

        expect(result.status).toBe('completed');
        expect(model.doStreamCalls.length).toBe(1);
        const types = emittedEventTypes(result.events);
        expect(types).not.toContain('llm.tool_call.proposed');
    });

    it('terminates cleanly when a turn fails after a tool step (no loop spin — review fix #1)', async () => {
        const model = buildErrorAfterToolModel();
        const toolRegistry = new ToolRegistry();
        toolRegistry.register(echoRegistration);

        const result = await runAbgGraph({
            graph: createCodingAgentGraph({ model: MODEL_SELECTION }),
            sessionId: 'session_coding_agent_error',
            now: () => NOW,
            modelProviderSelection: MODEL_SELECTION,
            registry: createCodingAgentNodeRegistry(),
            resolveSdkModel: () => model,
            toolRegistry,
            initialMessages: [{ role: 'user', content: 'echo hi then finish' }],
        });

        // Step 1 proposed+executed the tool (loop_active set true), step 2 errored. The
        // failure is bounded by the retry limit (maxAttempts=3) and then fails the graph —
        // it does NOT spin re-entering llm-actor until maxNodeRuns (40).
        expect(result.status).toBe('failed');
        expect(model.doStreamCalls.length).toBeLessThan(10);
    });
});
