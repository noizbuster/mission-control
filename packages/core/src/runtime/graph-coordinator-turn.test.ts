/**
 * Tests for the graph turn runner + the coordinator's pluggable-turn-runner seam. This is the
 * headless proof that the session queue/steer/resume machinery can drive the ABG coding-agent
 * graph instead of the flat provider loop:
 *
 *   - `mapGraphTurnResult` / `agentMessagesToSeedModelMessages` are pure and unit-tested directly.
 *   - `createGraphTurnRunner` runs a real scripted-model graph end-to-end through a stub context.
 *   - The coordinator seam routes to an injected runner (and does NOT touch the flat provider).
 *   - A capstone wires `createGraphTurnRunner` into a real `SessionRunCoordinator` and proves a
 *     steered prompt completes with graph events persisted to the durable store.
 *
 * Sandbox-blocked and therefore NOT covered here: real-provider turns (the env proxy is not a real
 * AI-SDK provider) and the interactive TUI approval broker. Those are flagged in the plan.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import type { AgentEvent, AgentMessage, ModelProviderSelection } from '@mission-control/protocol';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodingAgentGraph } from '../behavior/coding-agent-graph.js';
import { createCodingAgentNodeRegistry } from '../behavior/coding-agent-registry.js';
import { ToolRegistry } from '../tools/tool-registry.js';
import {
    agentMessagesToSeedModelMessages,
    createGraphTurnRunner,
    mapGraphTurnResult,
} from './graph-coordinator-turn.js';
import { type RunCoordinatorTurnContext, SessionRunCoordinator } from './run-coordinator.js';
import {
    cleanupCoordinatorContexts,
    openCoordinatorContext,
    providerFromRequests,
} from './run-coordinator-test-support.js';

const NOW = '2026-06-16T00:00:00.000Z';
const MODEL_SELECTION: ModelProviderSelection = { providerID: 'anthropic', modelID: 'claude-fable-5' };

afterEach(async () => {
    await cleanupCoordinatorContexts();
});

function buildUsage() {
    return {
        inputTokens: { total: 4, noCache: 4, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 6, text: 6, reasoning: 0 },
    };
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

function buildScriptedModel(): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        provider: MODEL_SELECTION.providerID,
        modelId: MODEL_SELECTION.modelID,
        doStream: async () => ({ stream: convertArrayToReadableStream(finalTextChunks()) }),
    });
}

function buildGraphWiring(model: MockLanguageModelV3) {
    return {
        graph: createCodingAgentGraph({ model: MODEL_SELECTION }),
        sessionId: 'session_graph_turn',
        now: () => NOW,
        modelProviderSelection: MODEL_SELECTION,
        registry: createCodingAgentNodeRegistry(),
        resolveSdkModel: () => model,
        toolRegistry: new ToolRegistry(),
    };
}

function buildStubContext(messages: readonly AgentMessage[]): {
    readonly context: RunCoordinatorTurnContext;
    readonly persisted: AgentEvent[];
} {
    const persisted: AgentEvent[] = [];
    let counter = 0;
    const context: RunCoordinatorTurnContext = {
        signal: new AbortController().signal,
        readMessages: async () => messages,
        nextId: async (prefix) => {
            counter += 1;
            return `${prefix}_${counter}`;
        },
        appendDurableEvent: async (event) => {
            persisted.push(event);
        },
        appendDurableEnvelope: async () => {},
    };
    return { context, persisted };
}

describe('mapGraphTurnResult', () => {
    it('maps completed/cancelled directly and falls back to a generic reason for failed/blocked with no events', () => {
        expect(mapGraphTurnResult({ graphId: 'g', status: 'completed', events: [] })).toEqual({ status: 'completed' });
        expect(mapGraphTurnResult({ graphId: 'g', status: 'cancelled', events: [] })).toEqual({
            status: 'interrupted',
        });
        const failed = mapGraphTurnResult({ graphId: 'g', status: 'failed', events: [] });
        expect(failed.status).toBe('failed');
        expect(failed).toMatchObject({ reason: 'graph run failed', errorCode: 'unknown' });
        const blocked = mapGraphTurnResult({ graphId: 'g', status: 'blocked', events: [] });
        expect(blocked.status).toBe('blocked_on_approval');
        expect(blocked).toMatchObject({ errorCode: 'unknown' });
        expect(blocked).toMatchObject({ reason: 'graph run blocked waiting for input' });
    });

    it('maps non-terminal created/active to failed so a wiring bug surfaces instead of a silent empty success', () => {
        const created = mapGraphTurnResult({ graphId: 'g', status: 'created', events: [] });
        expect(created.status).toBe('failed');
        expect(created).toMatchObject({ reason: 'graph settled non-terminally as created', errorCode: 'unknown' });
        const active = mapGraphTurnResult({ graphId: 'g', status: 'active', events: [] });
        expect(active.status).toBe('failed');
        expect(active).toMatchObject({ reason: 'graph settled non-terminally as active', errorCode: 'unknown' });
    });
});

describe('agentMessagesToSeedModelMessages', () => {
    it('maps system/user/assistant text and skips tool results', () => {
        const messages: AgentMessage[] = [
            { role: 'system', content: 'be brief' },
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi there' },
            { role: 'tool', toolCallId: 'call_1', status: 'completed', output: 'ignored' },
            { role: 'user', content: 'again' },
        ];
        expect(agentMessagesToSeedModelMessages(messages)).toEqual([
            { role: 'system', content: 'be brief' },
            { role: 'user', content: 'hello' },
            { role: 'assistant', content: 'hi there' },
            { role: 'user', content: 'again' },
        ]);
    });

    it('seeds nothing from an empty conversation', () => {
        expect(agentMessagesToSeedModelMessages([])).toEqual([]);
    });
});

describe('createGraphTurnRunner', () => {
    it('seeds a fresh graph run from admitted messages, persists events, and reports completed', async () => {
        const model = buildScriptedModel();
        const runner = createGraphTurnRunner(buildGraphWiring(model));
        const { context, persisted } = buildStubContext([{ role: 'user', content: 'just answer' }]);

        const result = await runner(context);

        expect(result.status).toBe('completed');
        expect(model.doStreamCalls.length).toBe(1);
        // The graph's AgentEvents flowed through the coordinator's durable sink.
        expect(persisted.length).toBeGreaterThan(0);
        expect(persisted.some((event) => (event.message ?? '').includes('llm.turn.completed'))).toBe(true);
    });

    it('reports interrupted when the drain aborts the run mid-graph', async () => {
        // The drain aborts via the controller on interrupt; the graph honors the abort signal and
        // settles as cancelled, which the runner maps to interrupted.
        const model = buildScriptedModel();
        const runner = createGraphTurnRunner(buildGraphWiring(model));
        const controller = new AbortController();
        const persisted: AgentEvent[] = [];
        const context: RunCoordinatorTurnContext = {
            signal: controller.signal,
            readMessages: async () => [{ role: 'user', content: 'just answer' }],
            nextId: async () => 'id',
            appendDurableEvent: async (event) => {
                persisted.push(event);
            },
            appendDurableEnvelope: async () => {},
        };
        controller.abort();

        const result = await runner(context);

        expect(result.status).toBe('interrupted');
    });
});

describe('SessionRunCoordinator turn-runner seam', () => {
    it('routes a steered prompt to the injected runner (not the flat provider) and reads admitted messages', async () => {
        const context = await openCoordinatorContext('session_graph_seam');
        let providerCalls = 0;
        const seen: string[] = [];

        const coordinator = new SessionRunCoordinator({
            sessionId: context.sessionId,
            store: context.store,
            provider: providerFromRequests(() => {
                providerCalls += 1;
                return Promise.resolve();
            }),
            modelProviderSelection: MODEL_SELECTION,
            now: () => NOW,
            createId: (prefix, index) => `${prefix}_${index}`,
            runProviderTurn: async (turnContext) => {
                seen.push(
                    ...(await turnContext.readMessages()).flatMap((message) =>
                        message.role === 'tool' ? [] : [message.content],
                    ),
                );
                return { status: 'completed' };
            },
        });

        await coordinator.steer({ inputId: 'input_seam', messageId: 'message_seam', prompt: 'hello graph' });
        const result = await coordinator.run();

        expect(result.status).toBe('completed');
        // The injected runner saw the promoted prompt and the flat provider was never invoked.
        expect(seen).toContain('hello graph');
        expect(providerCalls).toBe(0);
        await context.store.close();
    });

    it('drives a real coding-agent graph through the coordinator and persists graph events durably', async () => {
        const context = await openCoordinatorContext('session_graph_engine');
        const model = buildScriptedModel();

        const coordinator = new SessionRunCoordinator({
            sessionId: context.sessionId,
            store: context.store,
            provider: providerFromRequests(() => Promise.resolve()),
            modelProviderSelection: MODEL_SELECTION,
            now: () => NOW,
            createId: (prefix, index) => `${prefix}_${index}`,
            runProviderTurn: createGraphTurnRunner({
                ...buildGraphWiring(model),
                sessionId: context.sessionId,
            }),
        });

        await coordinator.steer({ inputId: 'input_engine', messageId: 'message_engine', prompt: 'just answer' });
        const result = await coordinator.run();
        const events = await context.events();

        expect(result.status).toBe('completed');
        expect(model.doStreamCalls.length).toBe(1);
        // Graph AgentEvents were persisted to the durable session store and replay as llm turns.
        expect(events.some((event) => (event.message ?? '').includes('llm.turn.completed'))).toBe(true);
        await context.store.close();
    });
});
