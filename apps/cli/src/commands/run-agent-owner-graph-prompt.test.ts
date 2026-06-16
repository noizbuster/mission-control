/**
 * `--engine graph --session` cutover tests. This is the headless proof that the session
 * queue/steer/resume machinery (`SessionRunOwner` → `SessionRunCoordinator`) can drive the ABG
 * coding-agent graph instead of the flat provider loop:
 *
 *   - E2E `runAgent(['--engine','graph','--session',...])` routes to the graph session branch,
 *     drives a scripted model through the graph turn runner, persists graph `AgentEvent`s to the
 *     durable session store, and never touches the flat provider.
 *   - A provider with no AI-SDK mapping is rejected eagerly — the session path runs the same
 *     `resolveGraphSdkModel` validation as the one-shot `--engine graph` path.
 *   - The owner layer propagates `runProviderTurn` into the coordinator's resume path: a queued
 *     prompt is promoted and driven to completion by `owner.resume()` through the graph engine.
 *
 * Sandbox-blocked and therefore NOT covered: real-provider turns (the env proxy is not a real
 * AI-SDK provider) and the interactive TUI approval broker.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import {
    createCodingAgentNodeRegistry,
    createGraphTurnRunner,
    JsonlSessionEventStore,
    type ProviderTurnRequest,
    type SdkModelResolver,
    SdkModelResolverError,
    SessionRunOwner,
    ToolRegistry,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { captureSequentialProvider, tempRoot } from './compact-command-test-support.js';
import { runAgent } from './run-agent.js';
import { createEmptyAuthStore } from './run-agent-chat-test-support.js';
import { buildCodingAgentGraphForSelection } from './run-agent-graph-prompt.js';
import { rm } from 'node:fs/promises';

const SELECTION: ModelProviderSelection = { providerID: 'openai', modelID: 'gpt-test' };
const NOW = '2026-06-16T00:00:00.000Z';

const roots: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
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

function buildScriptedModel(onDoStream?: (options: unknown) => void): MockLanguageModelV3 {
    return new MockLanguageModelV3({
        provider: SELECTION.providerID,
        modelId: SELECTION.modelID,
        doStream: async (options) => {
            onDoStream?.(options);
            return { stream: convertArrayToReadableStream(finalTextChunks()) };
        },
    });
}

function readMessages(events: readonly AgentEvent[]): string {
    return events.map((event) => event.message ?? '').join('\n');
}

describe('runAgent --engine graph --session (graph session engine dispatch)', () => {
    it('drives the coding-agent graph through the session owner and persists graph events', async () => {
        const dataDir = await tempRoot(roots, 'mctrl-graph-session-dispatch-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_graph_engine_dispatch';
        const requests: ProviderTurnRequest[] = [];
        const seen: unknown[] = [];
        const model = buildScriptedModel((options) => seen.push(options));

        await runAgent(
            // No --provider/--model: the default selection drives dispatch, while the injected
            // resolver supplies the scripted model regardless of the selection's provider mapping.
            parseArgs(['--no-tui', '--engine', 'graph', '--session', sessionId, 'just answer']),
            {
                authStore: createEmptyAuthStore(),
                provider: captureSequentialProvider(requests, []),
                resolveSdkModel: () => model,
            },
        );

        // The graph turn runner drove the turn; the flat provider was never invoked.
        expect(requests).toHaveLength(0);
        expect(model.doStreamCalls.length).toBe(1);
        // The admitted prompt was seeded into the graph run's model call (the seeding contract
        // createGraphTurnRunner relies on via agentMessagesToSeedModelMessages).
        expect(JSON.stringify(seen)).toContain('just answer');

        const store = await JsonlSessionEventStore.open({ sessionId, dataDir });
        const events = await store.getEvents(sessionId);
        await store.close();
        // Graph AgentEvents were persisted to the durable session store and replay as llm turns.
        expect(readMessages(events)).toContain('llm.turn.completed');
    });

    it('rejects a provider with no AI-SDK mapping before the graph session run starts', async () => {
        const dataDir = await tempRoot(roots, 'mctrl-graph-session-reject-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const throwingResolver: SdkModelResolver = () => {
            throw new SdkModelResolverError('no mapping');
        };

        await expect(
            runAgent(parseArgs(['--no-tui', '--engine', 'graph', '--session', 'session_graph_reject', 'hi']), {
                authStore: createEmptyAuthStore(),
                resolveSdkModel: throwingResolver,
            }),
        ).rejects.toThrow(/graph engine supports AI-SDK-backed providers/);
    });
});

describe('SessionRunOwner graph engine (runProviderTurn propagation)', () => {
    it('queues a prompt, then resume drives it to completion through the graph engine', async () => {
        const dataDir = await tempRoot(roots, 'mctrl-graph-session-queue-');
        const sessionId = 'session_graph_queue_resume';
        const store = await JsonlSessionEventStore.open({ sessionId, dataDir });
        const model = buildScriptedModel();
        const owner = new SessionRunOwner({
            sessionId,
            store,
            provider: captureSequentialProvider([], []),
            modelProviderSelection: SELECTION,
            now: () => NOW,
            runProviderTurn: createGraphTurnRunner({
                graph: buildCodingAgentGraphForSelection(SELECTION),
                sessionId,
                now: () => NOW,
                modelProviderSelection: SELECTION,
                registry: createCodingAgentNodeRegistry(),
                resolveSdkModel: () => model,
                toolRegistry: new ToolRegistry(),
            }),
        });

        try {
            const queued = await owner.queue({
                prompt: 'just answer',
                inputId: 'input_q',
                messageId: 'message_q',
            });
            expect(queued.status).toBe('queued');
            // Queuing admits the prompt but does not run the graph.
            expect(model.doStreamCalls.length).toBe(0);

            const resumed = await owner.resume();
            expect(resumed.status).toBe('completed');
            // Resume promoted the queued input and drove one graph run.
            expect(model.doStreamCalls.length).toBe(1);

            const events = await store.getEvents(sessionId);
            expect(readMessages(events)).toContain('llm.turn.completed');
        } finally {
            await owner.close();
        }
    });
});
