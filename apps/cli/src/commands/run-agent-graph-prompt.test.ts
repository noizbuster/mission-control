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
    type ToolRegistration,
    ToolRegistry,
} from '@mission-control/core';
import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry.js';
import {
    buildCodingAgentGraphForSelection,
    resolveGraphSdkModel,
    runCodingPromptOnGraph,
} from './run-agent-graph-prompt.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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

/** A tool-call stream proposing the REAL `repo.read` tool against a workspace-relative path. */
function repoReadCallChunks(path: string): LanguageModelV3StreamPart[] {
    const input = JSON.stringify({ path });
    return [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-input-start', id: 'call_read', toolName: 'repo.read' },
        { type: 'tool-input-delta', id: 'call_read', delta: input },
        { type: 'tool-input-end', id: 'call_read' },
        { type: 'tool-call', toolCallId: 'call_read', toolName: 'repo.read', input },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: undefined }, usage: buildUsage() },
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

    it('runs the full tool-then-finalize loop through the CLI wiring (graph owns the loop)', async () => {
        // Step 1 proposes the `echo` tool; step 2 produces the final answer. Proves the graph's
        // self-edge (llm.loop_active) drives multi-step tool use through the CLI helper — not just
        // single-turn text — with tools resolving via the injected registry.
        let callCount = 0;
        const model = new MockLanguageModelV3({
            provider: SELECTION.providerID,
            modelId: SELECTION.modelID,
            doStream: async () => {
                callCount += 1;
                const chunks = callCount === 1 ? toolCallChunks() : finalTextChunks();
                return { stream: convertArrayToReadableStream(chunks) };
            },
        });
        const toolRegistry = new ToolRegistry();
        toolRegistry.register(echoRegistration);

        const runtime = new AgentRuntime({ modelProviderSelection: SELECTION });
        await runtime.start();
        try {
            const result = await runCodingPromptOnGraph({
                runtime,
                selection: SELECTION,
                prompt: 'echo hi then finish',
                workspaceRoot: process.cwd(),
                resolveSdkModel: () => model,
                toolRegistry,
            });

            expect(result.status).toBe('completed');
            expect(model.doStreamCalls.length).toBe(2);
            const messages = runtime
                .getEvents()
                .map((event) => event.message ?? '')
                .join('\n');
            expect(messages).toContain('llm.tool_call.proposed');
            expect(messages).toContain('tool.completed');
            expect(messages.match(/llm\.turn\.completed/g)?.length).toBe(2);
        } finally {
            await runtime.stop();
        }
    });

    it('drives the REAL repo.read tool through the multi-turn loop (not a hand-registered echo)', async () => {
        // Strengthens the tool-loop proof beyond the scripted `echo` tool: the REAL production
        // `repo.read` tool — registered via `createNonInteractiveToolRegistry`, the SAME factory the
        // `--engine graph` path builds — is proposed by a scripted model, dispatched through the
        // tool-bridge, executed against a real temp-workspace file (workspace guard + fs read), its
        // settlement output flows back through the loop, and the run finalizes in exactly two model
        // calls. This proves the real-tool plumbing (permission → guard → execute → settle → resume)
        // end-to-end, not just a no-op echo.
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mission-control-graph-realtool-'));
        tempDirs.push(workspaceRoot);
        const token = 'GRAPH_TOOL_TOKEN_77';
        await writeFile(join(workspaceRoot, 'token.txt'), token);

        const toolRegistry = await createNonInteractiveToolRegistry({
            workspaceRoot,
            // Reads are auto-allowed in production; mirror that here. The scripted model only ever
            // proposes `repo.read`, so no workspace mutation occurs.
            requestPermission: async (request) => ({ requestId: request.id, status: 'allow' as const }),
        });

        let callCount = 0;
        const model = new MockLanguageModelV3({
            provider: SELECTION.providerID,
            modelId: SELECTION.modelID,
            doStream: async () => {
                callCount += 1;
                const chunks = callCount === 1 ? repoReadCallChunks('token.txt') : finalTextChunks();
                return { stream: convertArrayToReadableStream(chunks) };
            },
        });

        const runtime = new AgentRuntime({ modelProviderSelection: SELECTION });
        await runtime.start();
        try {
            const result = await runCodingPromptOnGraph({
                runtime,
                selection: SELECTION,
                prompt: 'read token.txt then finish',
                workspaceRoot,
                resolveSdkModel: () => model,
                toolRegistry: toolRegistry.registry,
            });

            expect(result.status).toBe('completed');
            // Exactly two model calls: the tool proposal, then the finalize after the result fed back.
            expect(model.doStreamCalls.length).toBe(2);
            const events = runtime.getEvents();
            const serialized = JSON.stringify(events);
            const messages = events.map((event) => event.message ?? '').join('\n');
            expect(messages).toContain('llm.tool_call.proposed');
            expect(messages).toContain('tool.completed');
            // The REAL `repo.read` tool was proposed + completed (not echo): the production tool name
            // appears in the event stream, and its settlement carried the file's actual contents —
            // proving the guard + fs read executed, not a stub.
            expect(serialized).toContain('repo.read');
            expect(serialized).toContain(token);
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

describe('resolveGraphSdkModel (shared graph resolver + validation)', () => {
    it('returns an injected resolver unchanged after validating it against the selection', async () => {
        const model = new MockLanguageModelV3({
            provider: SELECTION.providerID,
            modelId: SELECTION.modelID,
            doStream: async () => ({ stream: convertArrayToReadableStream(finalTextChunks()) }),
        });
        const resolver: SdkModelResolver = () => model;

        // resolveGraphSdkModel calls the resolver once to validate it supports the selection.
        // The injected scripted resolver returns the model without throwing, so validation passes
        // and the resolver is returned verbatim (shared by the one-shot and session graph paths).
        expect(await resolveGraphSdkModel({ selection: SELECTION, resolveSdkModel: resolver })).toBe(resolver);
    });

    it('rejects a provider with no AI-SDK mapping with the shared clear error', async () => {
        const throwingResolver: SdkModelResolver = () => {
            throw new SdkModelResolverError('no mapping');
        };
        await expect(
            resolveGraphSdkModel({
                selection: { providerID: 'local', modelID: 'local-echo' },
                resolveSdkModel: throwingResolver,
            }),
        ).rejects.toThrow(/graph engine supports AI-SDK-backed providers/);
    });

    it('buildCodingAgentGraphForSelection binds the selection into a graph spec', () => {
        // Smoke check that the shared graph builder produces a spec without throwing — the
        // session path relies on the same bound graph the one-shot path uses.
        expect(() => buildCodingAgentGraphForSelection(SELECTION)).not.toThrow();
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
        // coding-step parity LANDED: the graph path persists boundary emits (`llm.turn.completed`)
        // on `abg.emit`, and the projection maps them to the SAME `CodingReplayStep` kinds the flat
        // provider path produces — so the final assistant text now appears in `codingSteps`. (This
        // was the precise remaining delta; it asserted `codingSteps` was empty before emit parity.)
        const messageSteps = replay.codingSteps.filter((step) => step.kind === 'provider.message');
        expect(messageSteps.length).toBeGreaterThanOrEqual(1);
        expect(messageSteps.some((step) => step.message === 'Done.')).toBe(true);
    });
});
