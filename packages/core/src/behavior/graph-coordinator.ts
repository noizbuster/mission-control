import type { AbgNodeSpec, AbgSignal, AgentEvent } from '@mission-control/protocol';
import { type AuthorableAbgGraph, createAuthorableAbgGraph } from './authorable-graph.js';
import {
    type CoordinatorState,
    createCoordinatorState,
    edgePriorityDescending,
    hasNode,
    nodeModel,
} from './graph-coordinator-helpers.js';
import { runQueuedNode } from './graph-coordinator-node-runner.js';
import { scheduleQueuedNodes } from './graph-coordinator-scheduler.js';
import type { AbgGraphRunnerInput, AbgGraphRunResult } from './graph-runner.js';
import { graphEvent } from './graph-runner-events.js';
import { createDefaultAbgNodeRegistry } from './node-registry.js';
import { projectAbgSignalToEvent } from './signals.js';

export async function runBoundedAbgGraph(input: AbgGraphRunnerInput): Promise<AbgGraphRunResult> {
    const graph = createAuthorableAbgGraph(input.graph);
    const registry = input.registry ?? createDefaultAbgNodeRegistry();
    const state = createCoordinatorState(graph, input);

    state.events.push(graphEvent('graph.started', graph.id, input, 'ABG graph started'));
    while (state.queuedNodeIds.length > 0) {
        if (state.totalNodeRuns >= state.maxNodeRuns) {
            return failGraph(graph.id, input, state.events, 'graph_loop_limit', 'ABG graph loop limit exceeded');
        }
        const scheduledNodes = scheduleQueuedNodes(graph, state, input);
        if (scheduledNodes.length === 0) {
            return failGraph(graph.id, input, state.events, 'graph_loop_limit', 'ABG graph made no progress');
        }
        const results = await Promise.all(
            scheduledNodes.map((node) => runQueuedNode(graph, node, registry, input, state)),
        );
        for (const result of results) {
            switch (result.kind) {
                case 'completed':
                    enqueueSelectedTargets(graph, result.node, result.lastSignal, state, input);
                    break;
                case 'failed':
                    if (result.attempt < state.maxAttempts) {
                        state.queuedNodeIds.unshift(result.node.id);
                        break;
                    }
                    return failGraph(
                        graph.id,
                        input,
                        state.events,
                        'node_retry_exhausted',
                        `ABG node retry limit exhausted: ${result.node.id}`,
                    );
                case 'blocked':
                    return { graphId: graph.id, status: 'blocked', events: state.events };
                default:
                    return assertNeverQueuedNodeResult(result);
            }
        }
    }

    state.events.push(graphEvent('graph.completed', graph.id, input, 'ABG graph completed'));
    return { graphId: graph.id, status: 'completed', events: state.events };
}

function enqueueSelectedTargets(
    graph: AuthorableAbgGraph,
    node: AbgNodeSpec,
    signal: AbgSignal | undefined,
    state: CoordinatorState,
    input: AbgGraphRunnerInput,
): void {
    if (signal?.type === 'select' && hasNode(graph, signal.target)) {
        state.queuedNodeIds.push(signal.target);
    }
    for (const edge of graph.edges.filter((candidate) => candidate.source === node.id).sort(edgePriorityDescending)) {
        const rule =
            edge.condition === undefined
                ? undefined
                : graph.compiledRules.find((candidate) => candidate.id === edge.condition);
        const evaluationInput = {
            nodeStatuses: state.nodeStatuses,
            ...(signal !== undefined ? { signalType: signal.type } : {}),
        };
        if (edge.condition !== undefined && rule?.matches(evaluationInput) !== true) {
            continue;
        }
        state.events.push(
            projectAbgSignalToEvent({
                graphId: graph.id,
                sessionId: input.sessionId,
                timestamp: input.now(),
                signal: {
                    type: 'select',
                    graphId: graph.id,
                    nodeId: node.id,
                    target: edge.target,
                    reason:
                        edge.condition !== undefined
                            ? `rule matched: ${edge.condition}`
                            : `edge selected: ${edge.target}`,
                },
                model: nodeModel(graph, node.id, input.modelProviderSelection),
            }),
        );
        state.queuedNodeIds.push(edge.target);
    }
}

function failGraph(
    graphId: string,
    input: AbgGraphRunnerInput,
    events: AgentEvent[],
    code: string,
    message: string,
): AbgGraphRunResult {
    events.push(graphFailureEvent(graphId, input, code, message));
    return { graphId, status: 'failed', events };
}

function graphFailureEvent(graphId: string, input: AbgGraphRunnerInput, code: string, message: string): AgentEvent {
    return graphEvent('graph.failed', graphId, input, message, {
        error: { code, message, retryable: false },
    });
}

function assertNeverQueuedNodeResult(result: never): never {
    throw new Error(`Unhandled queued node result: ${String(result)}`);
}
