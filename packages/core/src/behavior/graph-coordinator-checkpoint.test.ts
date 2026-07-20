import type { AbgNodeSpec, AbgSignal, AgentEvent, GraphCheckpoint } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { approvalGraph } from './graph-coordinator-test-support';
import { runAbgGraph } from './graph-runner';
import type { AbgNodeRunContext } from './node-registry';
import { createAbgNodeRegistry, createDefaultAbgNodeRegistry } from './node-registry';

const NOW = '2026-07-20T00:00:00.000Z';

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
        expect(checkpoint?.nodeStatuses['gate']).toBe('succeeded');
        expect(checkpoint?.attemptsByNodeId['gate']).toBe(1);
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
        expect(checkpoint?.nodeStatuses['approve']).toBe('blocked');
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
        expect(checkpoint?.nodeStatuses['slow']).not.toBe('succeeded');
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
