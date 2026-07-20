import type { AbgNodeSpec, AbgSignal, AgentEvent, GraphCheckpoint } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createAbgEmitSignal, resetEmitSequence } from './abg-emit';
import { createAuthorableAbgGraph } from './authorable-graph';
import { createCoordinatorState } from './graph-coordinator-helpers';
import { approvalGraph } from './graph-coordinator-test-support';
import { runAbgGraph } from './graph-runner';
import type { AbgNodeRunContext } from './node-registry';
import { createAbgNodeRegistry, createDefaultAbgNodeRegistry } from './node-registry';

const NOW = '2026-07-20T00:00:00.000Z';
const GATE_NODE_ID = 'gate';
const APPROVE_NODE_ID = 'approve';
const SLOW_NODE_ID = 'slow';

const baseInput = {
    sessionId: 'session_graph_checkpoint',
    now: () => NOW,
    modelProviderSelection: {
        providerID: 'local',
        modelID: 'local-echo',
    },
} as const;

describe('bounded ABG graph checkpoint emission', () => {
    it('emits a node-boundary checkpoint after successful routing enqueues the successor', async () => {
        // Given: a two-node graph where the first node writes durable routing state.
        const registry = createAbgNodeRegistry();
        registry.register('write-ready', async function* run(node, context): AsyncIterable<AbgSignal> {
            yield startedSignal(node, context);
            context.blackboard?.set('plan.ready', true);
            context.blackboard?.set('llm.loop_active', true);
            yield successSignal(node, context);
        });
        registry.register('sink', async function* run(node, context): AsyncIterable<AbgSignal> {
            yield startedSignal(node, context);
            yield successSignal(node, context);
        });

        // When: the first node completes and routes to the second.
        const result = await runAbgGraph({
            ...baseInput,
            registry,
            graph: {
                id: 'checkpoint-linear',
                entryNodeId: 'gate',
                nodes: [
                    { id: 'gate', kind: 'action', implementation: 'write-ready' },
                    { id: 'next', kind: 'action', implementation: 'sink' },
                ],
                edges: [{ source: 'gate', target: 'next' }],
                rules: [],
                policies: [],
            },
        });

        // Then: the checkpoint captures post-enqueue queue state and filtered blackboard entries.
        expect(result.status).toBe('completed');
        const checkpoint = checkpoints(result.events).find(
            (candidate) => candidate.reason === 'node_boundary' && candidate.completedNodeIds.includes('gate'),
        );
        expect(checkpoint?.queuedNodeIds).toContain('next');
        expect(checkpoint?.nodeStatuses[GATE_NODE_ID]).toBe('succeeded');
        expect(checkpoint?.attemptsByNodeId[GATE_NODE_ID]).toBe(1);
        expect(checkpoint?.totalNodeRuns).toBe(1);
        expect(checkpoint?.blackboardEntries['plan.ready']).toBe(true);
        expect('llm.loop_active' in (checkpoint?.blackboardEntries ?? {})).toBe(false);
    });

    it('emits an approval-block checkpoint with the blocked node queued for resume', async () => {
        // Given: a human approval node with no approval decision.
        const result = await runAbgGraph({
            ...baseInput,
            graph: approvalGraph('checkpoint-approval-block'),
        });

        // Then: the checkpoint is durable, approval-scoped, and does not mark the node completed.
        expect(result.status).toBe('blocked');
        const checkpoint = checkpoints(result.events).find((candidate) => candidate.reason === 'approval_block');
        expect(checkpoint?.queuedNodeIds).toEqual(['approve']);
        expect(checkpoint?.completedNodeIds).not.toContain('approve');
        expect(checkpoint?.nodeStatuses[APPROVE_NODE_ID]).toBe('blocked');
    });

    it('emits an interrupt checkpoint before returning provider_aborted from a mid-node abort', async () => {
        // Given: a node that observes the owner abort while it is in progress.
        const controller = new AbortController();
        const registry = createAbgNodeRegistry();
        registry.register('abort-self', async function* run(node, context): AsyncIterable<AbgSignal> {
            yield startedSignal(node, context);
            controller.abort();
            yield providerAbortedSignal(node, context);
        });

        // When: the graph aborts during the node attempt.
        const result = await runAbgGraph({
            ...baseInput,
            registry,
            abortSignal: controller.signal,
            graph: {
                id: 'checkpoint-mid-node-abort',
                entryNodeId: 'slow',
                nodes: [{ id: 'slow', kind: 'llm', implementation: 'abort-self' }],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        // Then: the interrupted node is queued, never completed, and checkpoint precedes graph.failed.
        expect(result.status).toBe('failed');
        expect(result.terminalError?.code).toBe('provider_aborted');
        const checkpoint = checkpoints(result.events).find((candidate) => candidate.reason === 'interrupt');
        expect(checkpoint?.queuedNodeIds).toEqual(['slow']);
        expect(checkpoint?.completedNodeIds).not.toContain('slow');
        expect(checkpoint?.nodeStatuses[SLOW_NODE_ID]).not.toBe('succeeded');
        expect(indexOfType(result.events, 'graph.checkpoint')).toBeLessThan(indexOfType(result.events, 'graph.failed'));
    });

    it('re-queues an active parallel parent in the interrupt checkpoint', async () => {
        // Given: a parallel wave whose first child aborts while the wave is active.
        const controller = new AbortController();
        const registry = createDefaultAbgNodeRegistry();
        registry.register('abort-first-child', async function* run(node, context): AsyncIterable<AbgSignal> {
            yield startedSignal(node, context);
            if (node.id === 'first') {
                controller.abort();
                yield providerAbortedSignal(node, context);
                return;
            }
            yield successSignal(node, context);
        });

        // When: the parallel parent settles after the child abort.
        const result = await runAbgGraph({
            ...baseInput,
            registry,
            abortSignal: controller.signal,
            graph: {
                id: 'checkpoint-parallel-abort',
                entryNodeId: 'wave',
                nodes: [
                    { id: 'wave', kind: 'parallel', children: ['first', 'second'], config: { concurrency: 2 } },
                    { id: 'first', kind: 'action', implementation: 'abort-first-child' },
                    { id: 'second', kind: 'action', implementation: 'abort-first-child' },
                ],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        // Then: resume restarts the parent wave rather than treating it as completed.
        expect(result.status).toBe('failed');
        const checkpoint = checkpoints(result.events).find((candidate) => candidate.reason === 'interrupt');
        expect(checkpoint?.queuedNodeIds).toEqual(['wave']);
        expect(checkpoint?.activeParallelParentIds).toEqual(['wave']);
        expect(checkpoint?.completedNodeIds).not.toContain('wave');
    });
});

describe('bounded ABG graph resume from checkpoint', () => {
    it('resumes a two-node chain from the post-gate checkpoint and runs only the successor', async () => {
        // Given: a linear graph whose first full run emits a node-boundary checkpoint after gate.
        const firstRegistry = createAbgNodeRegistry();
        firstRegistry.register('write-ready', async function* run(node, context): AsyncIterable<AbgSignal> {
            yield startedSignal(node, context);
            context.blackboard?.set('plan.ready', true);
            yield successSignal(node, context);
        });
        firstRegistry.register('sink', async function* run(node, context): AsyncIterable<AbgSignal> {
            yield startedSignal(node, context);
            yield successSignal(node, context);
        });
        const graph = {
            id: 'resume-linear',
            entryNodeId: 'gate',
            nodes: [
                { id: 'gate', kind: 'action', implementation: 'write-ready' },
                { id: 'next', kind: 'action', implementation: 'sink' },
            ],
            edges: [{ source: 'gate', target: 'next' }],
            rules: [],
            policies: [],
        } as const;
        const first = await runAbgGraph({ ...baseInput, registry: firstRegistry, graph });
        const checkpoint = checkpoints(first.events).find(
            (candidate) => candidate.reason === 'node_boundary' && candidate.completedNodeIds.includes('gate'),
        );
        expect(checkpoint).toBeDefined();
        if (checkpoint === undefined) {
            throw new Error('expected node-boundary checkpoint after gate');
        }

        // When: a fresh run resumes from that checkpoint with execution counters.
        const executed: string[] = [];
        const resumeRegistry = createAbgNodeRegistry();
        resumeRegistry.register('write-ready', async function* run(node, context): AsyncIterable<AbgSignal> {
            executed.push(node.id);
            yield startedSignal(node, context);
            yield successSignal(node, context);
        });
        resumeRegistry.register('sink', async function* run(node, context): AsyncIterable<AbgSignal> {
            executed.push(node.id);
            yield startedSignal(node, context);
            yield successSignal(node, context);
        });
        const resumed = await runAbgGraph({
            ...baseInput,
            registry: resumeRegistry,
            graph,
            resumeCheckpoint: checkpoint,
        });

        // Then: only the queued successor executes; the completed gate is not re-run.
        expect(resumed.status).toBe('completed');
        expect(executed).toEqual(['next']);
        expect(checkpoint.blackboardEntries['plan.ready']).toBe(true);
    });

    it('fails closed with resume_invalid_checkpoint when a queued node id is unknown', async () => {
        // Given: a checkpoint that queues a node absent from the graph.
        const checkpoint = baseCheckpoint({
            graphId: 'resume-unknown',
            queuedNodeIds: ['missing-node'],
            completedNodeIds: [],
            nodeStatuses: {},
        });

        // When: resume is attempted against a one-node graph.
        const result = await runAbgGraph({
            ...baseInput,
            resumeCheckpoint: checkpoint,
            graph: {
                id: 'resume-unknown',
                entryNodeId: 'only',
                nodes: [{ id: 'only', kind: 'action' }],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        // Then: the run fails closed with a stable resume code.
        expect(result.status).toBe('failed');
        expect(result.terminalError?.code).toBe('resume_invalid_checkpoint');
        expect(result.events.some((event) => event.type === 'graph.failed')).toBe(true);
    });

    it('keeps a fresh run on the entry node with an empty blackboard', () => {
        // Given: no resumeCheckpoint on a two-node graph.
        const graph = createAuthorableAbgGraph({
            id: 'fresh-entry',
            entryNodeId: 'start',
            nodes: [
                { id: 'start', kind: 'action' },
                { id: 'end', kind: 'action' },
            ],
            edges: [{ source: 'start', target: 'end' }],
            rules: [],
            policies: [],
        });

        // When: coordinator state is created for a fresh run.
        const state = createCoordinatorState(graph, {
            ...baseInput,
            graph,
        });

        // Then: the queue starts at the entry and the blackboard has no seeded entries.
        expect(state.queuedNodeIds).toEqual(['start']);
        expect(state.nodeStatuses).toEqual({});
        expect(state.totalNodeRuns).toBe(0);
        expect(state.blackboard.toRecord()).toEqual({});
    });

    it('resumes a queued successor without requiring llm.loop_active in the blackboard', async () => {
        // Given: coding-agent-style loop edge on llm.loop_active plus an unconditional successor.
        // Checkpoint strips turn-local loop_active (as emit does) while still queuing the successor.
        const executed: string[] = [];
        const registry = createAbgNodeRegistry();
        registry.register('actor', async function* run(node, context): AsyncIterable<AbgSignal> {
            executed.push(node.id);
            yield startedSignal(node, context);
            yield successSignal(node, context);
        });
        registry.register('sink', async function* run(node, context): AsyncIterable<AbgSignal> {
            executed.push(node.id);
            yield startedSignal(node, context);
            yield successSignal(node, context);
        });
        const checkpoint = baseCheckpoint({
            graphId: 'resume-loop-strip',
            queuedNodeIds: ['next'],
            completedNodeIds: ['actor'],
            nodeStatuses: { actor: 'succeeded' },
            attemptsByNodeId: { actor: 1 },
            totalNodeRuns: 1,
            blackboardEntries: { 'plan.ready': true },
        });
        expect('llm.loop_active' in checkpoint.blackboardEntries).toBe(false);

        // When: resume runs with the stripped blackboard and queued successor.
        const result = await runAbgGraph({
            ...baseInput,
            registry,
            resumeCheckpoint: checkpoint,
            graph: {
                id: 'resume-loop-strip',
                entryNodeId: 'actor',
                nodes: [
                    { id: 'actor', kind: 'action', implementation: 'actor' },
                    { id: 'next', kind: 'action', implementation: 'sink' },
                ],
                edges: [
                    {
                        source: 'actor',
                        target: 'actor',
                        condition: 'llm-loop-active',
                        priority: 10,
                    },
                    { source: 'actor', target: 'next', priority: 0 },
                ],
                rules: [
                    {
                        id: 'llm-loop-active',
                        when: {
                            kind: 'blackboard.value.equals',
                            key: 'llm.loop_active',
                            value: true,
                        },
                    },
                ],
                policies: [],
            },
        });

        // Then: queuedNodeIds is the resume cursor — next runs without loop_active.
        expect(result.status).toBe('completed');
        expect(executed).toEqual(['next']);
        expect(result.events.some((event) => event.type === 'attempt.started' && event.abg?.nodeId === 'actor')).toBe(
            false,
        );
    });

    it('always resets the emit sequence on resume so node-level ids restart at 1', () => {
        // Given: a prior emit sequence advanced for the same graph id.
        resetEmitSequence('resume-emit-reset');
        createAbgEmitSignal({
            graphId: 'resume-emit-reset',
            nodeId: 'prior',
            eventType: 'probe',
            timestamp: NOW,
        });
        createAbgEmitSignal({
            graphId: 'resume-emit-reset',
            nodeId: 'prior',
            eventType: 'probe',
            timestamp: NOW,
        });
        const graph = createAuthorableAbgGraph({
            id: 'resume-emit-reset',
            entryNodeId: 'only',
            nodes: [{ id: 'only', kind: 'action' }],
            edges: [],
            rules: [],
            policies: [],
        });
        const checkpoint = baseCheckpoint({
            graphId: 'resume-emit-reset',
            queuedNodeIds: ['only'],
            completedNodeIds: [],
            nodeStatuses: {},
        });

        // When: coordinator state is created for resume (must reset emit sequence).
        createCoordinatorState(graph, {
            ...baseInput,
            graph,
            resumeCheckpoint: checkpoint,
        });
        const signal = createAbgEmitSignal({
            graphId: 'resume-emit-reset',
            nodeId: 'after',
            eventType: 'probe',
            timestamp: NOW,
        });

        // Then: the next emit id restarts at sequence 1.
        expect(signal.type).toBe('emit');
        if (signal.type === 'emit') {
            expect(signal.event.id).toBe('resume-emit-reset.after.probe.1');
        }
    });

    it('does not re-execute a succeeded node if it is still present in the resume queue', async () => {
        // Given: a checkpoint that incorrectly still queues a succeeded node ahead of the successor.
        const executed: string[] = [];
        const registry = createAbgNodeRegistry();
        registry.register('probe', async function* run(node, context): AsyncIterable<AbgSignal> {
            executed.push(node.id);
            yield startedSignal(node, context);
            yield successSignal(node, context);
        });
        const checkpoint = baseCheckpoint({
            graphId: 'resume-skip-succeeded',
            queuedNodeIds: ['done', 'next'],
            completedNodeIds: ['done'],
            nodeStatuses: { done: 'succeeded' },
            attemptsByNodeId: { done: 1 },
            totalNodeRuns: 1,
        });

        // When: resume schedules the queue.
        const result = await runAbgGraph({
            ...baseInput,
            registry,
            resumeCheckpoint: checkpoint,
            graph: {
                id: 'resume-skip-succeeded',
                entryNodeId: 'done',
                nodes: [
                    { id: 'done', kind: 'action', implementation: 'probe' },
                    { id: 'next', kind: 'action', implementation: 'probe' },
                ],
                edges: [],
                rules: [],
                policies: [],
            },
        });

        // Then: only the incomplete successor runs.
        expect(result.status).toBe('completed');
        expect(executed).toEqual(['next']);
    });
});

function baseCheckpoint(input: {
    readonly graphId: string;
    readonly queuedNodeIds: readonly string[];
    readonly completedNodeIds: readonly string[];
    readonly nodeStatuses: GraphCheckpoint['nodeStatuses'];
    readonly attemptsByNodeId?: GraphCheckpoint['attemptsByNodeId'];
    readonly totalNodeRuns?: number;
    readonly blackboardEntries?: GraphCheckpoint['blackboardEntries'];
}): GraphCheckpoint {
    return {
        schemaVersion: 1,
        graphId: input.graphId,
        reason: 'node_boundary',
        queuedNodeIds: [...input.queuedNodeIds],
        completedNodeIds: [...input.completedNodeIds],
        nodeStatuses: { ...input.nodeStatuses },
        attemptsByNodeId: { ...(input.attemptsByNodeId ?? {}) },
        consecutiveFailuresByNodeId: {},
        consecutiveToolFailuresByNodeId: {},
        totalNodeRuns: input.totalNodeRuns ?? 0,
        budgetExtensionsUsed: 0,
        maxNodeRuns: 48,
        blackboardEntries: { ...(input.blackboardEntries ?? {}) },
        activeParallelParentIds: [],
        createdAt: NOW,
    };
}

function checkpoints(events: readonly AgentEvent[]): readonly GraphCheckpoint[] {
    return events.flatMap((event) => {
        const checkpoint = event.abg?.checkpoint;
        return event.type === 'graph.checkpoint' && checkpoint !== undefined ? [checkpoint] : [];
    });
}

function indexOfType(events: readonly AgentEvent[], type: AgentEvent['type']): number {
    return events.findIndex((event) => event.type === type);
}

function startedSignal(node: AbgNodeSpec, context: AbgNodeRunContext): AbgSignal {
    return { type: 'started', graphId: context.graphId, nodeId: node.id };
}

function successSignal(node: AbgNodeSpec, context: AbgNodeRunContext): AbgSignal {
    return { type: 'success', graphId: context.graphId, nodeId: node.id };
}

function providerAbortedSignal(node: AbgNodeSpec, context: AbgNodeRunContext): AbgSignal {
    return {
        type: 'failure',
        graphId: context.graphId,
        nodeId: node.id,
        error: {
            code: 'provider_aborted',
            message: 'provider turn aborted',
            providerError: true,
            retryable: false,
        },
    };
}
