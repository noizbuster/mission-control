// allow: SIZE_OK -- HEAD 343 -> current 753 pure LOC; one graph-turn adapter and coordinator-seam integration matrix.
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
import type {
    AbgEmbeddedEvent,
    AbgNodeSpec,
    AbgSignal,
    AgentEvent,
    AgentMessage,
    GraphCheckpoint,
    ModelProviderSelection,
} from '@mission-control/protocol';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, describe, expect, it } from 'vitest';
import { createCodingAgentGraph } from '../behavior/coding-agent-graph';
import { createCodingAgentNodeRegistry } from '../behavior/coding-agent-registry';
import { approvalGraph } from '../behavior/graph-coordinator-test-support';
import type { AbgNodeRunContext } from '../behavior/node-registry';
import { createAbgNodeRegistry } from '../behavior/node-registry';
import { createObservabilityRedactor } from '../providers/observability-redactor';
import { ToolRegistry } from '../tools/tool-registry';
import {
    agentMessagesToSeedModelMessages,
    createGraphTurnRunner,
    flushGraphTurnEvents,
    isInterruptFlushEvent,
    mapGraphTurnResult,
} from './graph-coordinator-turn';
import { type RunCoordinatorTurnContext, SessionRunCoordinator } from './run-coordinator';
import {
    cleanupCoordinatorContexts,
    openCoordinatorContext,
    providerFromRequests,
} from './run-coordinator-test-support';

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

function buildStubContext(
    messages: readonly AgentMessage[],
    options: {
        readonly command?: RunCoordinatorTurnContext['command'];
        readonly sessionEvents?: readonly AgentEvent[];
    } = {},
): {
    readonly context: RunCoordinatorTurnContext;
    readonly persisted: AgentEvent[];
} {
    const persisted: AgentEvent[] = [];
    let counter = 0;
    const sessionEvents = options.sessionEvents;
    const context: RunCoordinatorTurnContext = {
        signal: new AbortController().signal,
        command: options.command ?? 'run',
        ...(sessionEvents !== undefined ? { readSessionEvents: async () => sessionEvents } : {}),
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

function linearResumeCheckpoint(input: {
    readonly graphId: string;
    readonly runId: string;
    readonly queuedNodeIds: readonly string[];
    readonly completedNodeIds: readonly string[];
}): GraphCheckpoint {
    return {
        schemaVersion: 1,
        graphId: input.graphId,
        sessionRunId: input.runId,
        reason: 'interrupt',
        queuedNodeIds: [...input.queuedNodeIds],
        completedNodeIds: [...input.completedNodeIds],
        nodeStatuses: Object.fromEntries(input.completedNodeIds.map((nodeId) => [nodeId, 'succeeded' as const])),
        attemptsByNodeId: Object.fromEntries(input.completedNodeIds.map((nodeId) => [nodeId, 1])),
        consecutiveFailuresByNodeId: {},
        consecutiveToolFailuresByNodeId: {},
        totalNodeRuns: input.completedNodeIds.length,
        budgetExtensionsUsed: 0,
        maxNodeRuns: 64,
        blackboardEntries: { 'plan.ready': true },
        activeParallelParentIds: [],
        createdAt: NOW,
    };
}

function interruptedSessionEvents(input: {
    readonly runId: string;
    readonly checkpoint: GraphCheckpoint;
}): AgentEvent[] {
    return [
        {
            type: 'run.started',
            timestamp: NOW,
            sessionId: 'session_graph_turn',
            message: 'run started',
            run: { runId: input.runId, command: 'run', state: 'running' },
        },
        {
            type: 'graph.checkpoint',
            timestamp: NOW,
            sessionId: 'session_graph_turn',
            run: { runId: input.runId },
            abg: { graphId: input.checkpoint.graphId, checkpoint: input.checkpoint },
        },
        {
            type: 'run.interrupted',
            timestamp: NOW,
            sessionId: 'session_graph_turn',
            message: 'run interrupted',
            run: {
                runId: input.runId,
                command: 'run',
                state: 'interrupted',
                reason: 'provider_aborted',
            },
        },
    ];
}

function buildLinearProbeRegistry(executed: string[]) {
    const registry = createAbgNodeRegistry();
    const probe = async function* run(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
        executed.push(node.id);
        yield { type: 'started', graphId: context.graphId, nodeId: node.id };
        yield { type: 'success', graphId: context.graphId, nodeId: node.id };
    };
    registry.register('probe-gate', probe);
    registry.register('probe-next', probe);
    return registry;
}

function linearProbeGraph(graphId: string) {
    return {
        id: graphId,
        entryNodeId: 'gate',
        nodes: [
            { id: 'gate', kind: 'action' as const, implementation: 'probe-gate' },
            { id: 'next', kind: 'action' as const, implementation: 'probe-next' },
        ],
        edges: [{ source: 'gate', target: 'next' }],
        rules: [],
        policies: [],
    };
}

describe('flushGraphTurnEvents', () => {
    it('retains canonical ABG boundary logs after abort while dropping raw log noise', async () => {
        // Given: mixed lifecycle, raw log, and replay-critical ABG boundary events after abort.
        const controller = new AbortController();
        controller.abort();
        const persisted: AgentEvent[] = [];
        const events: AgentEvent[] = [
            {
                type: 'node.started',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                message: 'node started',
            },
            {
                type: 'log',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                message: 'node emitted event: llm.text.delta',
            },
            {
                type: 'log',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                message: 'node emitted event: llm.turn.completed',
                abg: {
                    graphId: 'graph_resume',
                    emit: {
                        type: 'llm.turn.completed',
                        payload: { text: 'persist this assistant response' },
                    },
                },
            },
            {
                type: 'log',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                message: 'node emitted event: context.packed',
                abg: {
                    graphId: 'graph_resume',
                    emit: {
                        type: 'context.packed',
                        payload: { estimatedTokens: 4200, cutPointIndex: 3, summarizedMessageCount: 2 },
                    },
                },
            },
            {
                type: 'tool.completed',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                taskId: 'tool_resume',
                toolResult: { toolCallId: 'tool_resume', status: 'completed' },
                abg: {
                    graphId: 'graph_resume',
                    emit: {
                        type: 'tool.completed',
                        payload: { toolCallId: 'tool_resume', toolName: 'repo.read', output: 'persist tool output' },
                    },
                },
            },
            {
                type: 'node.completed',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                message: 'node completed',
            },
        ];
        const context: RunCoordinatorTurnContext = {
            signal: controller.signal,
            command: 'run',
            readMessages: async () => [],
            nextId: async (prefix) => prefix,
            appendDurableEvent: async (event) => {
                persisted.push(event);
            },
            appendDurableEnvelope: async () => {},
        };

        // When
        await flushGraphTurnEvents(context, events);

        // Then: raw stream noise is still skipped, but replay-critical boundaries survive.
        expect(persisted.map((event) => event.type)).toEqual([
            'node.started',
            'log',
            'log',
            'tool.completed',
            'node.completed',
        ]);
        expect(persisted[1]?.abg?.emit).toEqual({
            type: 'llm.turn.completed',
            payload: { text: 'persist this assistant response' },
        });
        expect(persisted[2]?.abg?.emit).toEqual({
            type: 'context.packed',
            payload: { estimatedTokens: 4200, cutPointIndex: 3, summarizedMessageCount: 2 },
        });
        expect(persisted[3]?.abg?.emit).toEqual({
            type: 'tool.completed',
            payload: { toolCallId: 'tool_resume', toolName: 'repo.read', output: 'persist tool output' },
        });
        expect(isInterruptFlushEvent(events[1] as AgentEvent)).toBe(false);
        expect(isInterruptFlushEvent(events[2] as AgentEvent)).toBe(true);
    });

    it('persists filtered checkpoint and graph failure boundaries through an abort-aware batch', async () => {
        // Given: an already-aborted turn with log noise before its checkpoint and graph failure.
        const controller = new AbortController();
        controller.abort();
        const checkpoint = linearResumeCheckpoint({
            graphId: 'post-abort-boundaries',
            runId: 'run_post_abort_boundaries',
            queuedNodeIds: ['resume-node'],
            completedNodeIds: ['checkpoint-node'],
        });
        const persisted: AgentEvent[] = [];
        const receivedSignals: Array<AbortSignal | undefined> = [];
        const events: AgentEvent[] = [
            {
                type: 'log',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                message: 'streaming noise',
            },
            {
                type: 'graph.checkpoint',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                abg: { graphId: checkpoint.graphId, checkpoint },
            },
            {
                type: 'graph.failed',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                message: 'ABG graph loop limit exceeded',
                abg: {
                    graphId: checkpoint.graphId,
                    error: {
                        code: 'graph_loop_limit',
                        message: 'ABG graph loop limit exceeded',
                        retryable: false,
                    },
                },
            },
        ];
        const context: RunCoordinatorTurnContext = {
            signal: controller.signal,
            command: 'run',
            readMessages: async () => [],
            nextId: async (prefix) => prefix,
            appendDurableEvent: async () => {
                throw new Error('should use batch path');
            },
            appendDurableEvents: async (batch, signal) => {
                receivedSignals.push(signal);
                if (signal?.aborted === true) {
                    return;
                }
                persisted.push(...batch);
            },
            appendDurableEnvelope: async () => {},
        };

        // When: the graph's post-abort boundary batch is flushed.
        await flushGraphTurnEvents(context, events);

        // Then: retained boundaries commit in source order without the cancelled batch signal.
        expect(persisted.map((event) => event.type)).toEqual(['graph.checkpoint', 'graph.failed']);
        expect(receivedSignals).toEqual([undefined]);
    });

    it('continues persisting replay boundaries after an interrupt cancels an earlier raw-log batch', async () => {
        // Given: the raw-log append is interrupted after the graph returned its event sequence.
        const controller = new AbortController();
        const persisted: AgentEvent[] = [];
        const receivedSignals: Array<AbortSignal | undefined> = [];
        const events: AgentEvent[] = [
            {
                type: 'log',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                message: 'raw diagnostic before completion',
            },
            {
                type: 'log',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                message: 'node emitted event: llm.turn.completed',
                abg: {
                    graphId: 'graph_resume',
                    emit: { type: 'llm.turn.completed', payload: { text: 'durable assistant response' } },
                },
            },
            {
                type: 'log',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                message: 'raw diagnostic after completion',
            },
            {
                type: 'node.completed',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                message: 'node completed',
            },
        ];
        const context: RunCoordinatorTurnContext = {
            signal: controller.signal,
            command: 'run',
            readMessages: async () => [],
            nextId: async (prefix) => prefix,
            appendDurableEvent: async () => {
                throw new Error('should use batch path');
            },
            appendDurableEvents: async (batch, signal) => {
                receivedSignals.push(signal);
                if (signal !== undefined) {
                    controller.abort();
                    return;
                }
                persisted.push(...batch);
            },
            appendDurableEnvelope: async () => {},
        };

        // When: the raw-log batch is cancelled mid-flush.
        await flushGraphTurnEvents(context, events);

        // Then: raw logs are droppable, but later replay boundaries still commit in source order.
        expect(persisted).toEqual([events[1], events[3]]);
        expect(receivedSignals.map((signal) => signal === undefined)).toEqual([false, true, true]);
    });

    it('uses appendDurableEvents batch path when provided', async () => {
        // Given
        const batches: AgentEvent[][] = [];
        const signals: Array<AbortSignal | undefined> = [];
        const signal = new AbortController().signal;
        const events: AgentEvent[] = [
            {
                type: 'node.started',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                message: 'node started',
            },
            {
                type: 'log',
                timestamp: NOW,
                sessionId: 'session_graph_turn',
                message: 'noise',
            },
        ];
        const context: RunCoordinatorTurnContext = {
            signal,
            command: 'run',
            readMessages: async () => [],
            nextId: async (prefix) => prefix,
            appendDurableEvent: async () => {
                throw new Error('should use batch path');
            },
            appendDurableEvents: async (batch, batchSignal) => {
                batches.push([...batch]);
                signals.push(batchSignal);
            },
            appendDurableEnvelope: async () => {},
        };

        // When
        await flushGraphTurnEvents(context, events);

        // Then: replay boundaries use an uncancellable batch; raw logs remain cancellable.
        expect(batches.map((batch) => batch.map((event) => event.type))).toEqual([['node.started'], ['log']]);
        expect(signals).toEqual([undefined, signal]);
    });

    it('keeps graph checkpoint events during aborted flushes', () => {
        const checkpoint: GraphCheckpoint = {
            schemaVersion: 1,
            graphId: 'graph-turn-checkpoint',
            reason: 'interrupt',
            queuedNodeIds: ['resume-node'],
            completedNodeIds: [],
            nodeStatuses: { resume: 'running' },
            attemptsByNodeId: { resume: 1 },
            consecutiveFailuresByNodeId: {},
            consecutiveToolFailuresByNodeId: {},
            totalNodeRuns: 1,
            budgetExtensionsUsed: 0,
            maxNodeRuns: 48,
            blackboardEntries: {},
            activeParallelParentIds: [],
            createdAt: NOW,
        };
        const event: AgentEvent = {
            type: 'graph.checkpoint',
            timestamp: NOW,
            sessionId: 'session_graph_turn',
            abg: { graphId: checkpoint.graphId, checkpoint },
        };

        expect(isInterruptFlushEvent(event)).toBe(true);
    });
});

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

    it('keeps provider_aborted as failed unless the run owner signal aborted', () => {
        // Given: a graph reports an abort-shaped provider error but no coordinator signal is available here.
        const failed = mapGraphTurnResult({
            graphId: 'g',
            status: 'failed',
            events: [],
            terminalError: { code: 'provider_aborted', message: 'provider aborted', retryable: false },
        });

        // Then: only createGraphTurnRunner's actual AbortSignal check may classify interruption.
        expect(failed).toMatchObject({ status: 'failed', errorCode: 'provider_aborted' });
    });

    it('propagates a tool_failed terminalError code as the protocol errorCode instead of unknown', () => {
        const failed = mapGraphTurnResult({
            graphId: 'g',
            status: 'failed',
            events: [],
            terminalError: {
                code: 'tool_failed',
                message: 'command_failed: command failed: ls biome*',
                retryable: false,
            },
        });
        expect(failed.status).toBe('failed');
        expect(failed).toMatchObject({
            errorCode: 'tool_failed',
            reason: 'command_failed: command failed: ls biome*',
        });
    });

    it('propagates provider_rate_limited as the errorCode when surfaced as terminalError', () => {
        const failed = mapGraphTurnResult({
            graphId: 'g',
            status: 'failed',
            events: [],
            terminalError: {
                code: 'provider_rate_limited',
                message: 'rate limited by provider',
                retryable: true,
            },
        });
        expect(failed).toMatchObject({ errorCode: 'provider_rate_limited' });
    });

    it('falls back to unknown errorCode for graph-internal codes not in ProtocolErrorCode', () => {
        const failed = mapGraphTurnResult({
            graphId: 'g',
            status: 'failed',
            events: [{ type: 'graph.failed', message: 'ABG graph loop limit exceeded' } as AgentEvent],
            terminalError: {
                code: 'graph_loop_limit',
                message: 'loop limit hit',
                retryable: false,
            },
        });
        expect(failed).toMatchObject({ errorCode: 'unknown' });
        expect(failed).toMatchObject({ reason: 'ABG graph loop limit exceeded' });
    });

    it('prefers the graph-level event message (which failGraph appends the cause to) over the bare terminalError message', () => {
        const failed = mapGraphTurnResult({
            graphId: 'g',
            status: 'failed',
            events: [
                {
                    type: 'graph.failed',
                    message:
                        'ABG run failed on a non-retryable tool settlement: llm-actor — command_failed: command failed: ls biome*',
                } as AgentEvent,
            ],
            terminalError: {
                code: 'tool_failed',
                message: 'command_failed: command failed: ls biome*',
                retryable: false,
            },
        });
        expect(failed).toMatchObject({
            errorCode: 'tool_failed',
            reason: 'ABG run failed on a non-retryable tool settlement: llm-actor — command_failed: command failed: ls biome*',
        });
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

    it('redacts configured credentials from live signals and persisted graph metadata', async () => {
        // Given
        const credential = ['configured', 'graph', 'metadata'].join('_');
        const model = buildScriptedModel();
        const baseGraph = createCodingAgentGraph({ model: MODEL_SELECTION });
        const observedSignals: AbgSignal[] = [];
        const runner = createGraphTurnRunner({
            ...buildGraphWiring(model),
            graph: { ...baseGraph, id: `graph-${credential}` },
            modelProviderSelection: {
                providerID: `provider-${credential}`,
                modelID: `model-${credential}`,
            },
            onSignal: (signal) => {
                observedSignals.push(signal);
            },
            observabilityRedactor: createObservabilityRedactor({ secrets: [credential] }),
        });
        const { context, persisted } = buildStubContext([{ role: 'user', content: 'just answer' }]);

        // When
        await runner(context);
        const observable = JSON.stringify({ observedSignals, persisted });

        // Then
        expect(observable).toContain('[REDACTED_CREDENTIAL]');
        expect(observable).not.toContain(credential);
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
            command: 'run',
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

describe('createGraphTurnRunner checkpoint seed-only-on-resume', () => {
    it('seeds resumeCheckpoint when command is resume and only runs queued successors', async () => {
        // Given: interrupted session ledger with a checkpoint that already completed gate.
        const graphId = 'turn-resume-seed';
        const runId = 'run_resume_seed';
        const checkpoint = linearResumeCheckpoint({
            graphId,
            runId,
            queuedNodeIds: ['next'],
            completedNodeIds: ['gate'],
        });
        const executed: string[] = [];
        const runner = createGraphTurnRunner({
            graph: linearProbeGraph(graphId),
            sessionId: 'session_resume_seed',
            now: () => NOW,
            modelProviderSelection: MODEL_SELECTION,
            registry: buildLinearProbeRegistry(executed),
        });
        const { context } = buildStubContext([{ role: 'user', content: 'continue work' }], {
            command: 'resume',
            sessionEvents: interruptedSessionEvents({ runId, checkpoint }),
        });

        // When: the turn runner is invoked with an explicit resume command.
        const result = await runner(context);

        // Then: only the queued successor runs; the completed gate is not re-executed.
        expect(result.status).toBe('completed');
        expect(executed).toEqual(['next']);
    });

    it('does not seed resumeCheckpoint on a normal run even when a checkpoint exists', async () => {
        // Given: the same interrupted ledger, but the drain command is a normal run.
        const graphId = 'turn-run-no-seed';
        const runId = 'run_no_seed';
        const checkpoint = linearResumeCheckpoint({
            graphId,
            runId,
            queuedNodeIds: ['next'],
            completedNodeIds: ['gate'],
        });
        const executed: string[] = [];
        const runner = createGraphTurnRunner({
            graph: linearProbeGraph(graphId),
            sessionId: 'session_run_no_seed',
            now: () => NOW,
            modelProviderSelection: MODEL_SELECTION,
            registry: buildLinearProbeRegistry(executed),
        });
        const { context } = buildStubContext([{ role: 'user', content: 'fresh prompt' }], {
            command: 'run',
            sessionEvents: interruptedSessionEvents({ runId, checkpoint }),
        });

        // When: the turn runner is invoked with run (not resume).
        const result = await runner(context);

        // Then: the graph starts at the entry and re-runs gate then next.
        expect(result.status).toBe('completed');
        expect(executed).toEqual(['gate', 'next']);
    });

    it('threads approval decisions on resume without double-executing a completed gate', async () => {
        // Given: approval resume with a checkpoint that already completed the gate node.
        const graphId = 'turn-approval-no-double';
        const runId = 'run_approval_no_double';
        const checkpoint = linearResumeCheckpoint({
            graphId,
            runId,
            queuedNodeIds: ['next'],
            completedNodeIds: ['gate'],
        });
        const executed: string[] = [];
        const decision: AbgEmbeddedEvent = {
            id: 'approval_decided_no_double',
            type: 'approval.updated',
            source: 'human',
            timestamp: NOW,
            payload: {
                approvalId: `approval_permission_${graphId}_approve`,
                state: 'approved',
                reason: 'approved by reviewer',
            },
        };
        const runner = createGraphTurnRunner({
            graph: linearProbeGraph(graphId),
            sessionId: 'session_approval_no_double',
            now: () => NOW,
            modelProviderSelection: MODEL_SELECTION,
            registry: buildLinearProbeRegistry(executed),
            readApprovalDecisions: async () => [decision],
        });
        const { context } = buildStubContext([{ role: 'user', content: 'continue after approval' }], {
            command: 'resume',
            sessionEvents: interruptedSessionEvents({ runId, checkpoint }),
        });

        // When
        const result = await runner(context);

        // Then: approval decisions are available and completed work is not re-run.
        expect(result.status).toBe('completed');
        expect(executed).toEqual(['next']);
    });
});

describe('createGraphTurnRunner approval resume', () => {
    // The resume logic itself (graphInput.events carrying an approval.updated decision unblocks a
    // human-approval node) is proven at the runAbgGraph level in
    // graph-coordinator-approval-concurrency.test.ts. These tests prove the TURN RUNNER threads
    // broker-provided decisions into graphInput.events — closing the "block but never resume" gap
    // on the coordinator-driven graph path.
    it('threads approval decisions into graphInput.events so a blocked human-approval node completes', async () => {
        const graphId = 'approval-turn-resume';
        const decision: AbgEmbeddedEvent = {
            id: 'approval_decided_resume',
            type: 'approval.updated',
            source: 'human',
            timestamp: NOW,
            payload: {
                approvalId: `approval_permission_${graphId}_approve`,
                state: 'approved',
                reason: 'approved by reviewer',
            },
        };
        const runner = createGraphTurnRunner({
            graph: approvalGraph(graphId),
            sessionId: 'session_approval_resume',
            now: () => NOW,
            modelProviderSelection: MODEL_SELECTION,
            readApprovalDecisions: async () => [decision],
        });
        const { context, persisted } = buildStubContext([{ role: 'user', content: 'proceed' }]);

        const result = await runner(context);

        expect(result.status).toBe('completed');
        // The gate observed the threaded decision and resumed (did not re-block).
        expect(persisted.some((event) => event.type === 'approval.resumed')).toBe(true);
    });

    it('blocks on the approval node and never resumes when no decision is provided', async () => {
        // Omitting readApprovalDecisions preserves the pre-existing behavior: the turn runner
        // passes no graphInput.events, so the gate never observes a decision → blocked_on_approval.
        const runner = createGraphTurnRunner({
            graph: approvalGraph('approval-turn-block'),
            sessionId: 'session_approval_block',
            now: () => NOW,
            modelProviderSelection: MODEL_SELECTION,
        });
        const { context, persisted } = buildStubContext([{ role: 'user', content: 'proceed' }]);

        const result = await runner(context);

        expect(result.status).toBe('blocked_on_approval');
        expect(persisted.some((event) => event.type === 'approval.requested')).toBe(true);
        expect(persisted.some((event) => event.type === 'approval.resumed')).toBe(false);
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

    it('forwards command=resume and reuses an interrupted run id with checkpoint', async () => {
        // Given: durable interrupted run with a queued checkpoint and a pending steered prompt.
        const context = await openCoordinatorContext('session_engine_resume_interrupt');
        const runId = 'run_interrupted_engine';
        const checkpoint = linearResumeCheckpoint({
            graphId: 'engine-resume-graph',
            runId,
            queuedNodeIds: ['next'],
            completedNodeIds: ['gate'],
        });
        for (const event of interruptedSessionEvents({ runId, checkpoint })) {
            await context.store.append({ ...event, sessionId: context.sessionId });
        }
        const seen: Array<{ readonly command: string; readonly runIdFromEvents?: string }> = [];

        const coordinator = new SessionRunCoordinator({
            sessionId: context.sessionId,
            store: context.store,
            provider: providerFromRequests(() => Promise.resolve()),
            modelProviderSelection: MODEL_SELECTION,
            now: () => NOW,
            createId: (prefix, index) => `${prefix}_${index}`,
            runProviderTurn: async (turnContext) => {
                const events = turnContext.readSessionEvents !== undefined ? await turnContext.readSessionEvents() : [];
                const resumableCheckpoint = events
                    .slice()
                    .reverse()
                    .find((event) => event.type === 'graph.checkpoint')?.abg?.checkpoint;
                seen.push({
                    command: turnContext.command,
                    ...(typeof resumableCheckpoint === 'object' &&
                    resumableCheckpoint !== null &&
                    'sessionRunId' in resumableCheckpoint &&
                    typeof resumableCheckpoint.sessionRunId === 'string'
                        ? { runIdFromEvents: resumableCheckpoint.sessionRunId }
                        : {}),
                });
                return { status: 'completed' };
            },
        });

        await coordinator.steer({
            inputId: 'input_resume_interrupt',
            messageId: 'message_resume_interrupt',
            prompt: 'resume interrupted work',
        });

        // When: cold resume after interrupt+checkpoint.
        const result = await coordinator.resume();
        const events = await context.events();

        // Then: drain forwarded resume command and reused the interrupted run id (no new run.* start id).
        expect(result.status).toBe('completed');
        expect(result.runId).toBe(runId);
        expect(seen).toEqual([{ command: 'resume', runIdFromEvents: runId }]);
        expect(
            events.some(
                (event) =>
                    event.type === 'run.command.received' &&
                    event.run?.command === 'resume' &&
                    event.run.runId === runId,
            ),
        ).toBe(true);
        await context.store.close();
    });

    it('forwards command=run without treating an older checkpoint as a resume seed signal', async () => {
        // Given: ledger still holds an older interrupt checkpoint, but the caller starts a normal run.
        const context = await openCoordinatorContext('session_engine_run_no_resume');
        const runId = 'run_old_interrupt';
        const checkpoint = linearResumeCheckpoint({
            graphId: 'engine-run-graph',
            runId,
            queuedNodeIds: ['next'],
            completedNodeIds: ['gate'],
        });
        for (const event of interruptedSessionEvents({ runId, checkpoint })) {
            await context.store.append({ ...event, sessionId: context.sessionId });
        }
        const seenCommands: string[] = [];

        const coordinator = new SessionRunCoordinator({
            sessionId: context.sessionId,
            store: context.store,
            provider: providerFromRequests(() => Promise.resolve()),
            modelProviderSelection: MODEL_SELECTION,
            now: () => NOW,
            createId: (prefix, index) => `${prefix}_${index}`,
            runProviderTurn: async (turnContext) => {
                seenCommands.push(turnContext.command);
                return { status: 'completed' };
            },
        });

        await coordinator.steer({
            inputId: 'input_run_no_resume',
            messageId: 'message_run_no_resume',
            prompt: 'new work',
        });

        // When
        const result = await coordinator.run();

        // Then: command stays run (seed-only-on-resume is the turn runner's job for this path).
        expect(result.status).toBe('completed');
        expect(seenCommands).toEqual(['run']);
        expect(result.runId).not.toBe(runId);
        await context.store.close();
    });
});
