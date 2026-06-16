/**
 * `--engine graph` wiring tests. `runCodingPromptOnGraph` is the additive strangler-fig seam
 * that constructs the graph wiring (registry + resolveSdkModel + toolRegistry +
 * initialMessages) `run-agent.ts` previously omitted, so `AgentRuntime.runGraph` drives a
 * REAL provider instead of the mock registry.
 *
 * The end-to-end "scripted model → completed graph run through the runtime" test mirrors
 * `agent-runtime-coding-agent.test.ts` (which proves the underlying `runGraph` mechanism);
 * here we prove the CLI helper assembles that same wiring. The flat loop is untouched.
 */
import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import {
    AgentRuntime,
    JsonlSessionEventStore,
    projectSessionReplay,
    type SdkModelResolver,
    SdkModelResolverError,
    ToolRegistry,
} from '@mission-control/core';
import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { runCodingPromptOnGraph } from './run-agent-graph-prompt.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SELECTION = { providerID: 'openai', modelID: 'gpt-test' } as const;

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

describe('runCodingPromptOnGraph (--engine graph wiring)', () => {
    it('drives the coding-agent graph through the runtime with a scripted model', async () => {
        const runtime = new AgentRuntime({ modelProviderSelection: SELECTION });
        await runtime.start();
        try {
            const model = new MockLanguageModelV3({
                provider: SELECTION.providerID,
                modelId: SELECTION.modelID,
                doStream: async () => ({ stream: convertArrayToReadableStream(finalTextChunks()) }),
            });

            const result = await runCodingPromptOnGraph({
                runtime,
                selection: SELECTION,
                prompt: 'just answer',
                workspaceRoot: process.cwd(),
                resolveSdkModel: () => model,
                toolRegistry: new ToolRegistry(),
            });

            expect(result.status).toBe('completed');
            expect(model.doStreamCalls.length).toBe(1);

            const messages = runtime
                .getEvents()
                .map((event) => event.message ?? '')
                .join('\n');
            expect(messages).toContain('llm.turn.completed');
        } finally {
            await runtime.stop();
        }
    });

    it('rejects a provider with no AI-SDK mapping with a clear error before the run starts', async () => {
        const runtime = new AgentRuntime({ modelProviderSelection: { providerID: 'local', modelID: 'x' } });
        await runtime.start();
        try {
            const throwingResolver: SdkModelResolver = () => {
                throw new SdkModelResolverError('no mapping');
            };
            await expect(
                runCodingPromptOnGraph({
                    runtime,
                    selection: { providerID: 'local', modelID: 'x' },
                    prompt: 'hi',
                    workspaceRoot: process.cwd(),
                    resolveSdkModel: throwingResolver,
                    toolRegistry: new ToolRegistry(),
                }),
            ).rejects.toThrow(/graph engine supports AI-SDK-backed providers/);
        } finally {
            await runtime.stop();
        }
    });

    it('requires an auth store when no resolver is injected', async () => {
        const runtime = new AgentRuntime({ modelProviderSelection: SELECTION });
        await runtime.start();
        try {
            await expect(
                runCodingPromptOnGraph({
                    runtime,
                    selection: SELECTION,
                    prompt: 'hi',
                    workspaceRoot: process.cwd(),
                    toolRegistry: new ToolRegistry(),
                }),
            ).rejects.toThrow(/injected resolver or an auth store/);
        } finally {
            await runtime.stop();
        }
    });
});

const tempDirs: string[] = [];

afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

function replayEnvelope(event: AgentEvent, sequence: number): AgentEventEnvelope {
    return {
        eventId: `event_${sequence}`,
        sequence,
        createdAt: event.timestamp,
        sessionId: event.sessionId ?? 'session_missing',
        durability: 'durable',
        event,
    };
}

describe('runCodingPromptOnGraph — durable session-replay parity', () => {
    // Answers the architect's "durable-store equivalence needs verification" finding: a graph run
    // emits AgentEvents through the runtime bus, the CLI recorder persists them to the JSONL
    // session store, and projectSessionReplay reconstructs the model turn + ABG timeline/graph
    // snapshot from that stream with no corruption. The flat-path-only provider ENVELOPES (which
    // feed the detailed `codingSteps` projection) are the precise remaining delta — locked in here.
    it('records graph events that project back to a clean, reconstructable session', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-graph-parity-'));
        tempDirs.push(dataDir);
        const sessionId = 'session_graph_replay_parity';
        const store = await JsonlSessionEventStore.open({ sessionId, dataDir });
        const appendPromises: Promise<void>[] = [];

        const runtime = new AgentRuntime({ modelProviderSelection: SELECTION });
        const unsubscribe = runtime.onEvent((event) => {
            // Mirror the CLI recorder: stamp the session id and append to the durable store.
            appendPromises.push(store.append({ ...event, sessionId }));
        });
        await runtime.start();
        try {
            const model = new MockLanguageModelV3({
                provider: SELECTION.providerID,
                modelId: SELECTION.modelID,
                doStream: async () => ({ stream: convertArrayToReadableStream(finalTextChunks()) }),
            });
            await runCodingPromptOnGraph({
                runtime,
                selection: SELECTION,
                prompt: 'answer the question',
                workspaceRoot: process.cwd(),
                resolveSdkModel: () => model,
                toolRegistry: new ToolRegistry(),
            });
        } finally {
            await runtime.stop();
        }
        unsubscribe();
        await Promise.all(appendPromises);

        // Read events while the store is still open, then close.
        const events = await store.getEvents(sessionId);
        await store.close();
        const replay = projectSessionReplay({
            sessionId,
            envelopes: events.map((event, sequence) => replayEnvelope(event, sequence)),
        });

        // The model turn + the ABG timeline + the graph snapshot reconstruct from the recorded
        // AgentEvent stream with no corruption. The `llm.*` emit types are encoded in log-event
        // messages (the durable `event.type` is session.*/graph.*/node.*/log), matching how
        // agent-runtime-coding-agent.test.ts reads them.
        const messages = replay.events.map((event) => event.message ?? '').join('\n');
        expect(messages).toContain('llm.turn.completed');
        expect(replay.diagnostics).toEqual([]);
        expect(replay.timeline.length).toBeGreaterThan(0);
        expect(replay.graphSnapshots.length).toBeGreaterThan(0);
        // Precise remaining gap: the flat path appends provider-turn ENVELOPES that feed
        // `codingSteps`; the graph path emits AgentEvents only, so codingSteps is empty until
        // envelope emission lands. Regression guard for that delta.
        expect(replay.codingSteps).toEqual([]);
    });
});
