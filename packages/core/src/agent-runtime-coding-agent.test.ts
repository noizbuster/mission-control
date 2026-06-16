/**
 * Phase 3 cutover mechanism: `AgentRuntime.runGraph` drives the REAL coding-agent graph
 * (Observe→Decide→Act loop, real LLMActor + tools) when given the Phase 1/2 inputs, and the
 * resulting events flow through the runtime's event bus (the same pipeline that persists to
 * the JSONL session store). The flat provider-turn loop is untouched (strangler-fig).
 *
 * This proves the cutover MECHANISM. The actual CLI switch is gated on the Phase 5
 * `resolveSdkModel` bridge (ProviderAdapter → AI-SDK model); until then the CLI defaults to
 * the flat loop and this path is exercised here with a scripted SDK model. The sibling
 * `agent-runtime-graph.test.ts` covers the generic (mock-registry) runGraph behavior.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentRuntime } from './agent-runtime.js';
import { createCodingAgentGraph } from './behavior/coding-agent-graph.js';
import { createCodingAgentNodeRegistry } from './behavior/coding-agent-registry.js';
import { ToolRegistry } from './tools/tool-registry.js';
import type { ToolRegistration } from './tools/tool-registry-types.js';

const MODEL_SELECTION = { providerID: 'local', modelID: 'local-coding' } as const;

function buildUsage() {
    return {
        inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 6, text: 6, reasoning: 0 },
    };
}

function toolCallChunks(): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-input-start', id: 'call_1', toolName: 'echo' },
        { type: 'tool-input-delta', id: 'call_1', delta: JSON.stringify({ text: 'hi' }) },
        { type: 'tool-input-end', id: 'call_1' },
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'echo', input: JSON.stringify({ text: 'hi' }) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: buildUsage() },
    ];
}

function finalTextChunks(): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't2' },
        { type: 'text-delta', id: 't2', delta: 'Done.' },
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

describe('AgentRuntime.runGraph — coding-agent cutover mechanism', () => {
    it('drives the real coding-agent graph and streams events through the runtime bus', async () => {
        const runtime = new AgentRuntime({ modelProviderSelection: MODEL_SELECTION });
        await runtime.start();

        let callCount = 0;
        const model = new MockLanguageModelV3({
            provider: MODEL_SELECTION.providerID,
            modelId: MODEL_SELECTION.modelID,
            doStream: async () => {
                callCount += 1;
                const chunks = callCount === 1 ? toolCallChunks() : finalTextChunks();
                return { stream: convertArrayToReadableStream(chunks) };
            },
        });

        const toolRegistry = new ToolRegistry();
        toolRegistry.register(echoRegistration);

        const result = await runtime.runGraph(createCodingAgentGraph({ model: MODEL_SELECTION }), undefined, {
            registry: createCodingAgentNodeRegistry(),
            resolveSdkModel: () => model,
            toolRegistry,
            initialMessages: [{ role: 'user', content: 'echo hi then finish' }],
        });

        // The loop ran two graph-driven steps (propose tool → finalize).
        expect(result.status).toBe('completed');
        expect(model.doStreamCalls.length).toBe(2);

        // Graph events flowed through the runtime's event bus (the JSONL persistence pipeline).
        const events = runtime.getEvents();
        const messages = events.map((event) => event.message ?? '').join('\n');
        expect(messages).toContain('llm.tool_call.proposed');
        expect(messages).toContain('tool.completed');
        expect(messages).toContain('llm.turn.completed');
    });
});
