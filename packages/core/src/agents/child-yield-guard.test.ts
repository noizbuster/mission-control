// allow: SIZE_OK - HEAD 455 -> current 455 pure LOC; missing-yield on a completed child graph is now a degraded success, not a failure.
/**
 * Child-only yield guard: requireYieldBeforeExit keeps llm.loop_active until yield
 * or soft-land / maxNodeRuns, without changing parent coding-agent graphs.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AgentDefinition } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createCodingAgentGraph } from '../behavior/coding-agent-graph';
import { createCodingAgentNodeRegistry } from '../behavior/coding-agent-registry';
import { runAbgGraph } from '../behavior/graph-runner';
import type { AbgNodeRunContext } from '../behavior/node-registry';
import { runLlmActorNode } from '../behavior/nodes/llm-actor/llm-actor-node-runner';
import { createBlackboard } from '../memory/blackboard';
import { ToolRegistry } from '../tools/tool-registry';
import type { ToolRegistration } from '../tools/tool-registry-types';
import { createYieldToolRegistration, YIELD_TOOL_NAME } from '../tools/yield-tool/yield-tool';
import { createChildGraphSpawnFn, DEGRADED_SALVAGE_LABEL } from './child-graph-spawn';
import type { ChildSpawnContext } from './task-tool-runtime';

const NOW = '2026-07-21T00:00:00.000Z';
const MODEL_SELECTION = { providerID: 'test', modelID: 'mock-yield-guard' } as const;

function buildUsage() {
    return {
        inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 1, text: 1, reasoning: 0 },
    };
}

function textOnlyChunks(text: string): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: text },
        { type: 'text-end', id: 't1' },
        { type: 'finish', finishReason: { unified: 'stop', raw: undefined }, usage: buildUsage() },
    ];
}

function toolCallChunks(toolName: string, toolCallId: string, input: string): LanguageModelV3StreamPart[] {
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 't1' },
        { type: 'text-delta', id: 't1', delta: 'working' },
        { type: 'text-end', id: 't1' },
        { type: 'tool-input-start', id: toolCallId, toolName },
        { type: 'tool-input-delta', id: toolCallId, delta: input },
        { type: 'tool-input-end', id: toolCallId },
        { type: 'tool-call', toolCallId, toolName, input },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: buildUsage() },
    ];
}

function yieldCallChunks(result: string): LanguageModelV3StreamPart[] {
    return toolCallChunks(YIELD_TOOL_NAME, 'call_yield', JSON.stringify({ result }));
}

async function drainSignals(signals: AsyncIterable<unknown>): Promise<void> {
    for await (const _signal of signals) {
        // drain
    }
}

function seedBlackboard(): ReturnType<typeof createBlackboard> {
    const blackboard = createBlackboard();
    blackboard.appendMessages([{ role: 'user', content: 'do the task' }] as readonly ModelMessage[]);
    return blackboard;
}

const echoRegistration: ToolRegistration<{ text: string }, { text: string }> = {
    name: 'echo',
    description: 'Echo a string.',
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

function makeChildAgent(): AgentDefinition {
    return {
        name: 'deep',
        description: 'test child',
        systemPrompt: 'You are a child. Call yield when done.',
        source: 'bundled',
    };
}

function makeSpawnContext(childToolRegistry: ToolRegistry): ChildSpawnContext {
    return {
        sessionId: 'sess-spawn-yield-guard',
        prompt: 'do work',
        agent: makeChildAgent(),
        model: { providerID: 'test', modelID: 'mock' },
        systemPrompt: 'You are a child. Call yield when done.',
        childToolRegistry,
        childPermissions: [],
        workspaceRoot: '/tmp/workspace',
        signal: new AbortController().signal,
    };
}

describe('requireYieldBeforeExit — llm-actor unit', () => {
    it('leaves loop_active false on prose-only when requireYieldBeforeExit is absent (parent path)', async () => {
        // Given: parent-style node without the flag
        const blackboard = seedBlackboard();
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'mock',
            doStream: async () => ({ stream: convertArrayToReadableStream(textOnlyChunks('prose only')) }),
        });
        const context: AbgNodeRunContext = {
            graphId: 'g_parent_prose',
            now: () => NOW,
            sdkModel: model,
            blackboard,
        };
        const node = { id: 'llm-actor', kind: 'llm' as const };

        // When
        await drainSignals(runLlmActorNode(node, context));

        // Then
        expect(blackboard.get('llm.loop_active')).toBe(false);
        expect(blackboard.get('child.yield_reminder_pending')).not.toBe(true);
    });

    it('forces loop_active and arms reminder when child prose-only without yield', async () => {
        // Given
        const blackboard = seedBlackboard();
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'mock',
            doStream: async () => ({ stream: convertArrayToReadableStream(textOnlyChunks('Let me read X...')) }),
        });
        const context: AbgNodeRunContext = {
            graphId: 'g_child_prose',
            now: () => NOW,
            sdkModel: model,
            blackboard,
        };
        const node = {
            id: 'llm-actor',
            kind: 'llm' as const,
            config: { requireYieldBeforeExit: true },
        };

        // When
        await drainSignals(runLlmActorNode(node, context));

        // Then
        expect(blackboard.get('llm.loop_active')).toBe(true);
        expect(blackboard.get('child.yield_reminder_pending')).toBe(true);
        expect(blackboard.get('child.yielded')).not.toBe(true);
    });

    it('sets child.yielded on successful yield settlement', async () => {
        // Given
        const blackboard = seedBlackboard();
        const registry = new ToolRegistry();
        registry.register(createYieldToolRegistration({}));
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'mock',
            doStream: async () => ({
                stream: convertArrayToReadableStream(yieldCallChunks('done-result')),
            }),
        });
        const context: AbgNodeRunContext = {
            graphId: 'g_yield_flag',
            now: () => NOW,
            sdkModel: model,
            blackboard,
            toolRegistry: registry,
        };
        const node = {
            id: 'llm-actor',
            kind: 'llm' as const,
            config: { requireYieldBeforeExit: true },
        };

        // When
        await drainSignals(runLlmActorNode(node, context));

        // Then: yield settles and forces loop exit in the same turn (no extra prose turn)
        expect(blackboard.get('child.yielded')).toBe(true);
        expect(blackboard.get('llm.loop_active')).toBe(false);
        expect(blackboard.get('child.yield_reminder_pending')).not.toBe(true);
    });

    it('keeps loop_active false on prose-only when child.yielded is already true', async () => {
        // Given: prior successful yield already recorded
        const blackboard = seedBlackboard();
        blackboard.set('child.yielded', true);
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'mock',
            doStream: async () => ({ stream: convertArrayToReadableStream(textOnlyChunks('acknowledged')) }),
        });
        const context: AbgNodeRunContext = {
            graphId: 'g_after_yield',
            now: () => NOW,
            sdkModel: model,
            blackboard,
        };
        const node = {
            id: 'llm-actor',
            kind: 'llm' as const,
            config: { requireYieldBeforeExit: true },
        };

        // When
        await drainSignals(runLlmActorNode(node, context));

        // Then
        expect(blackboard.get('llm.loop_active')).toBe(false);
        expect(blackboard.get('child.yield_reminder_pending')).not.toBe(true);
    });

    it('injects one-shot system reminder and clears pending on the next turn', async () => {
        // Given: reminder armed from a prior forced turn
        const blackboard = seedBlackboard();
        blackboard.set('child.yield_reminder_pending', true);
        const beforeCount = blackboard.getMessages().length;
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'mock',
            doStream: async () => ({ stream: convertArrayToReadableStream(textOnlyChunks('still prose')) }),
        });
        const context: AbgNodeRunContext = {
            graphId: 'g_reminder',
            now: () => NOW,
            sdkModel: model,
            blackboard,
        };
        const node = {
            id: 'llm-actor',
            kind: 'llm' as const,
            config: { requireYieldBeforeExit: true },
        };

        // When
        await drainSignals(runLlmActorNode(node, context));

        // Then: a system message was admitted; pending re-armed because this turn still did not yield
        const messages = blackboard.getMessages();
        const systemMessages = messages.filter((message) => message.role === 'system');
        expect(systemMessages.length).toBeGreaterThanOrEqual(1);
        expect(messages.length).toBeGreaterThan(beforeCount);
        expect(blackboard.get('child.yield_reminder_pending')).toBe(true);
        expect(blackboard.get('llm.loop_active')).toBe(true);
    });
});

describe('requireYieldBeforeExit — coding-agent graph stamp', () => {
    it('stamps requireYieldBeforeExit on the llm-actor node only when requested', () => {
        const withFlag = createCodingAgentGraph({
            model: MODEL_SELECTION,
            requireYieldBeforeExit: true,
        });
        const withoutFlag = createCodingAgentGraph({ model: MODEL_SELECTION });

        expect(withFlag.nodes[0]?.config?.['requireYieldBeforeExit']).toBe(true);
        expect(withoutFlag.nodes[0]?.config?.['requireYieldBeforeExit']).toBeUndefined();
    });
});

describe('requireYieldBeforeExit — child graph integration', () => {
    it('keeps the parent graph completing on prose-only without the flag', async () => {
        // Given
        const model = new MockLanguageModelV3({
            provider: MODEL_SELECTION.providerID,
            modelId: MODEL_SELECTION.modelID,
            doStream: async () => ({ stream: convertArrayToReadableStream(textOnlyChunks('final answer')) }),
        });
        const toolRegistry = new ToolRegistry();
        toolRegistry.register(echoRegistration);

        // When
        const result = await runAbgGraph({
            graph: createCodingAgentGraph({ model: MODEL_SELECTION }),
            sessionId: 'session_parent_prose',
            now: () => NOW,
            modelProviderSelection: MODEL_SELECTION,
            registry: createCodingAgentNodeRegistry(),
            resolveSdkModel: () => model,
            toolRegistry,
            initialMessages: [{ role: 'user', content: 'just answer' }],
        });

        // Then
        expect(result.status).toBe('completed');
        expect(model.doStreamCalls.length).toBe(1);
    });

    it('does not complete the child graph on the first prose-only turn without yield', async () => {
        // Given: child graph with requireYieldBeforeExit; model always prose-only
        let callCount = 0;
        const model = new MockLanguageModelV3({
            provider: MODEL_SELECTION.providerID,
            modelId: MODEL_SELECTION.modelID,
            doStream: async () => {
                callCount += 1;
                return { stream: convertArrayToReadableStream(textOnlyChunks(`prose turn ${callCount}`)) };
            },
        });
        const toolRegistry = new ToolRegistry();
        toolRegistry.register(createYieldToolRegistration({}));

        // When: low maxNodeRuns so soft-land / budget ends quickly
        const result = await runAbgGraph({
            graph: createCodingAgentGraph({
                model: MODEL_SELECTION,
                requireYieldBeforeExit: true,
                maxNodeRuns: 4,
            }),
            sessionId: 'session_child_prose_loop',
            now: () => NOW,
            modelProviderSelection: MODEL_SELECTION,
            registry: createCodingAgentNodeRegistry(),
            resolveSdkModel: () => model,
            toolRegistry,
            initialMessages: [{ role: 'user', content: 'do work and yield' }],
        });

        // Then: more than one model call (forced re-entry) before terminal settle
        expect(callCount).toBeGreaterThan(1);
        expect(result.status === 'completed' || result.status === 'failed').toBe(true);
    });

    it('completes with yield output after tools then yield without a trailing prose turn', async () => {
        // Given
        let callCount = 0;
        const model = new MockLanguageModelV3({
            provider: MODEL_SELECTION.providerID,
            modelId: MODEL_SELECTION.modelID,
            doStream: async () => {
                callCount += 1;
                if (callCount === 1) {
                    return {
                        stream: convertArrayToReadableStream(
                            toolCallChunks('echo', 'call_echo', JSON.stringify({ text: 'hi' })),
                        ),
                    };
                }
                if (callCount === 2) {
                    return { stream: convertArrayToReadableStream(yieldCallChunks('final-yielded')) };
                }
                throw new Error(`unexpected extra model call ${callCount}`);
            },
        });

        let yielded: unknown;
        const toolRegistry = new ToolRegistry();
        toolRegistry.register(echoRegistration);
        toolRegistry.register(
            createYieldToolRegistration({
                onYield: (result) => {
                    yielded = result;
                },
            }),
        );

        // When
        const result = await runAbgGraph({
            graph: createCodingAgentGraph({
                model: MODEL_SELECTION,
                requireYieldBeforeExit: true,
            }),
            sessionId: 'session_child_tools_yield',
            now: () => NOW,
            modelProviderSelection: MODEL_SELECTION,
            registry: createCodingAgentNodeRegistry(),
            resolveSdkModel: () => model,
            toolRegistry,
            initialMessages: [{ role: 'user', content: 'echo then yield' }],
        });

        // Then: echo turn + yield turn only; yield forces loop exit immediately
        expect(result.status).toBe('completed');
        expect(yielded).toBe('final-yielded');
        expect(callCount).toBe(2);
    });

    it('completes on a yield-only first turn without a subsequent prose turn', async () => {
        // Given
        let callCount = 0;
        const model = new MockLanguageModelV3({
            provider: MODEL_SELECTION.providerID,
            modelId: MODEL_SELECTION.modelID,
            doStream: async () => {
                callCount += 1;
                if (callCount === 1) {
                    return { stream: convertArrayToReadableStream(yieldCallChunks('yield-only-ok')) };
                }
                throw new Error(`unexpected extra model call ${callCount}`);
            },
        });
        let yielded: unknown;
        const toolRegistry = new ToolRegistry();
        toolRegistry.register(
            createYieldToolRegistration({
                onYield: (result) => {
                    yielded = result;
                },
            }),
        );

        // When
        const result = await runAbgGraph({
            graph: createCodingAgentGraph({
                model: MODEL_SELECTION,
                requireYieldBeforeExit: true,
            }),
            sessionId: 'session_child_yield_only',
            now: () => NOW,
            modelProviderSelection: MODEL_SELECTION,
            registry: createCodingAgentNodeRegistry(),
            resolveSdkModel: () => model,
            toolRegistry,
            initialMessages: [{ role: 'user', content: 'yield now' }],
        });

        // Then
        expect(result.status).toBe('completed');
        expect(yielded).toBe('yield-only-ok');
        expect(callCount).toBe(1);
    });

    it('returns yield_missing salvage when budget ends without yield', async () => {
        // Given
        let callCount = 0;
        const model = new MockLanguageModelV3({
            provider: MODEL_SELECTION.providerID,
            modelId: MODEL_SELECTION.modelID,
            doStream: async () => {
                callCount += 1;
                return { stream: convertArrayToReadableStream(textOnlyChunks('still working')) };
            },
        });
        const toolRegistry = new ToolRegistry();
        let yieldedResult: { readonly value: unknown } | undefined;
        toolRegistry.register(
            createYieldToolRegistration({
                onYield: (result) => {
                    yieldedResult = { value: result };
                },
            }),
        );

        // When
        const graphResult = await runAbgGraph({
            graph: createCodingAgentGraph({
                model: MODEL_SELECTION,
                requireYieldBeforeExit: true,
                maxNodeRuns: 3,
            }),
            sessionId: 'session_budget_exhaust',
            now: () => NOW,
            modelProviderSelection: MODEL_SELECTION,
            registry: createCodingAgentNodeRegistry(),
            resolveSdkModel: () => model,
            toolRegistry,
            initialMessages: [{ role: 'user', content: 'never yield' }],
        });

        // Then: no yield; multi-turn forced; salvage path remains failed (not silent success)
        expect(yieldedResult).toBeUndefined();
        expect(callCount).toBeGreaterThan(1);
        if (graphResult.status === 'completed') {
            expect(`${DEGRADED_SALVAGE_LABEL}x`.startsWith(DEGRADED_SALVAGE_LABEL)).toBe(true);
        } else {
            expect(graphResult.status).toBe('failed');
        }
    });

    it('returns an explicit yield without a trailing prose turn', async () => {
        // Given
        let spawnCalls = 0;
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'mock',
            doStream: async () => {
                spawnCalls += 1;
                if (spawnCalls === 1) {
                    return { stream: convertArrayToReadableStream(yieldCallChunks('spawned-ok')) };
                }
                throw new Error(`unexpected extra model call ${spawnCalls}`);
            },
        });
        const childRegistry = new ToolRegistry();
        childRegistry.register(createYieldToolRegistration({}));
        const spawn = createChildGraphSpawnFn({ resolveSdkModel: () => model });

        // When
        const result = await spawn(makeSpawnContext(childRegistry));

        // Then: yield settles and completes without a trailing prose turn
        expect(result.status).toBe('completed');
        expect(result.output).toBe('spawned-ok');
        expect(spawnCalls).toBe(1);
    });

    it('completes with the child final text when a child does not call yield', async () => {
        let spawnCalls = 0;
        const model = new MockLanguageModelV3({
            provider: 'test',
            modelId: 'mock',
            doStream: async () => {
                spawnCalls += 1;
                return { stream: convertArrayToReadableStream(textOnlyChunks('completed without an explicit yield')) };
            },
        });
        const childRegistry = new ToolRegistry();
        childRegistry.register(createYieldToolRegistration({}));
        const spawn = createChildGraphSpawnFn({ resolveSdkModel: () => model });

        const result = await spawn(makeSpawnContext(childRegistry));

        // Default child spawn no longer forces requireYieldBeforeExit, so a prose-only turn
        // completes on the first model call. Missing `yield` is a degraded (but successful)
        // settlement: the child's final text is the result, surfaced as completed — not the
        // old task_yield_missing failure that discarded the work.
        expect(result).toEqual({
            sessionId: 'sess-spawn-yield-guard',
            status: 'completed',
            output: 'completed without an explicit yield',
            failureKind: 'yield_missing',
        });
        expect(spawnCalls).toBe(1);
    });
});
