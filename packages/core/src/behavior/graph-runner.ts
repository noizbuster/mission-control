import type {
    AbgGraphInput,
    AbgGraphStatus,
    AbgNodeModelOptions,
    AbgNodeSpec,
    AbgNodeStatus,
    AbgPolicySpec,
    AbgSignal,
    AgentEvent,
    ModelProviderSelection,
} from '@mission-control/protocol';
import { type AuthorableAbgGraph, createAuthorableAbgGraph } from './authorable-graph.js';
import { graphEvent, modelCallEvent, permissionEvent, policyBlockedEvent } from './graph-runner-events.js';
import {
    type AbgNodeRegistry,
    type AbgObservedGraphEvent,
    createDefaultAbgNodeRegistry,
    runAbgNode,
} from './node-registry.js';
import { projectAbgSignalToEvent } from './signals.js';

export type AbgGraphRunnerInput = {
    readonly graph: unknown;
    readonly graphInput?: AbgGraphInput;
    readonly sessionId: string;
    readonly now: () => string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly registry?: AbgNodeRegistry;
};

export type AbgGraphRunResult = {
    readonly graphId: string;
    readonly status: AbgGraphStatus;
    readonly events: readonly AgentEvent[];
};

export async function runAbgGraph(input: AbgGraphRunnerInput): Promise<AbgGraphRunResult> {
    const graph = createAuthorableAbgGraph(input.graph);
    const registry = input.registry ?? createDefaultAbgNodeRegistry();
    const events: AgentEvent[] = [];
    const nodeStatuses: Record<string, AbgNodeStatus | undefined> = {};
    const queuedNodeIds = [graph.entryNodeId];
    const visitedNodeIds = new Set<string>();

    events.push(graphEvent('graph.started', graph.id, input, 'ABG graph started'));
    while (queuedNodeIds.length > 0) {
        const nodeId = queuedNodeIds.shift();
        if (nodeId === undefined || visitedNodeIds.has(nodeId)) {
            continue;
        }
        visitedNodeIds.add(nodeId);
        const node = findNode(graph, nodeId);
        const blocked = findBlockingPolicy(node, graph.policies);
        if (blocked !== undefined) {
            events.push(permissionEvent(graph.id, node, blocked, input));
            events.push(policyBlockedEvent(graph.id, node, blocked, input));
            events.push(graphEvent('graph.failed', graph.id, input, `ABG graph blocked: ${node.id}`));
            return { graphId: graph.id, status: 'blocked', events };
        }

        const model = nodeModel(graph, node.id, input.modelProviderSelection);
        if (node.kind === 'llm') {
            events.push(modelCallEvent('model.call.started', graph.id, node, input, model));
        }
        const runResult = await runNode(graph, node, registry, input, nodeStatuses, events, model);
        if (node.kind === 'llm') {
            events.push(modelCallEvent('model.call.completed', graph.id, node, input, model));
        }
        if (runResult.status === 'failed') {
            events.push(graphEvent('graph.failed', graph.id, input, `ABG graph failed: ${node.id}`));
            return { graphId: graph.id, status: 'failed', events };
        }
        enqueueSelectedTargets(graph, node, runResult.lastSignal, nodeStatuses, input, events, queuedNodeIds);
    }

    events.push(graphEvent('graph.completed', graph.id, input, 'ABG graph completed'));
    return { graphId: graph.id, status: 'completed', events };
}

type NodeRunResult = {
    readonly status: 'completed' | 'failed';
    readonly lastSignal?: AbgSignal;
};

async function runNode(
    graph: AuthorableAbgGraph,
    node: AbgNodeSpec,
    registry: AbgNodeRegistry,
    input: AbgGraphRunnerInput,
    nodeStatuses: Record<string, AbgNodeStatus | undefined>,
    events: AgentEvent[],
    model: AbgNodeModelOptions,
): Promise<NodeRunResult> {
    let lastSignal: AbgSignal | undefined;
    let failed = false;
    for await (const signal of runAbgNode(registry, node, runContext(graph, registry, input))) {
        lastSignal = signal;
        nodeStatuses[signal.nodeId] = nodeStatusForSignal(signal);
        if (signal.type === 'failure') {
            failed = true;
        }
        events.push(
            projectAbgSignalToEvent({
                graphId: graph.id,
                sessionId: input.sessionId,
                timestamp: input.now(),
                signal,
                model: nodeModel(graph, signal.nodeId, input.modelProviderSelection) ?? model,
            }),
        );
    }
    return {
        status: failed ? 'failed' : 'completed',
        ...(lastSignal !== undefined ? { lastSignal } : {}),
    };
}

function runContext(graph: AuthorableAbgGraph, registry: AbgNodeRegistry, input: AbgGraphRunnerInput) {
    const nodes = Object.fromEntries(graph.nodes.map((node) => [node.id, node]));
    return {
        graphId: graph.id,
        now: input.now,
        registry,
        nodes,
        policies: graph.policies,
        model: graph.defaults?.model ?? runtimeModel(input.modelProviderSelection),
        ...(input.graphInput?.events !== undefined ? { observedEvents: input.graphInput.events } : {}),
        ...(input.graphInput?.input !== undefined ? { input: input.graphInput.input } : {}),
    } satisfies {
        readonly graphId: string;
        readonly now: () => string;
        readonly registry: AbgNodeRegistry;
        readonly nodes: Readonly<Record<string, AbgNodeSpec | undefined>>;
        readonly policies: readonly AbgPolicySpec[];
        readonly model: AbgNodeModelOptions;
        readonly observedEvents?: readonly AbgObservedGraphEvent[];
        readonly input?: Readonly<Record<string, unknown>>;
    };
}

function enqueueSelectedTargets(
    graph: AuthorableAbgGraph,
    node: AbgNodeSpec,
    signal: AbgSignal | undefined,
    nodeStatuses: Readonly<Record<string, AbgNodeStatus | undefined>>,
    input: AbgGraphRunnerInput,
    events: AgentEvent[],
    queuedNodeIds: string[],
): void {
    if (signal?.type === 'select' && hasNode(graph, signal.target)) {
        queuedNodeIds.push(signal.target);
    }
    for (const edge of graph.edges.filter((candidate) => candidate.source === node.id).sort(edgePriorityDescending)) {
        const rule =
            edge.condition === undefined
                ? undefined
                : graph.compiledRules.find((candidate) => candidate.id === edge.condition);
        const evaluationInput = {
            nodeStatuses,
            ...(signal !== undefined ? { signalType: signal.type } : {}),
        };
        if (edge.condition !== undefined && rule?.matches(evaluationInput) !== true) {
            continue;
        }
        events.push(
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
        queuedNodeIds.push(edge.target);
    }
}

function findNode(graph: AuthorableAbgGraph, nodeId: string): AbgNodeSpec {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) {
        throw new Error(`Unknown ABG graph node: ${nodeId}`);
    }
    return node;
}

function hasNode(graph: AuthorableAbgGraph, nodeId: string): boolean {
    return graph.nodes.some((node) => node.id === nodeId);
}

function findBlockingPolicy(node: AbgNodeSpec, policies: readonly AbgPolicySpec[]): AbgPolicySpec | undefined {
    return policies.find(
        (policy) => policy.decision !== 'allow' && (node.capabilities ?? []).includes(policy.capability),
    );
}

function nodeModel(
    graph: AuthorableAbgGraph,
    nodeId: string,
    modelProviderSelection: ModelProviderSelection,
): AbgNodeModelOptions {
    return (
        graph.nodes.find((node) => node.id === nodeId)?.model ??
        graph.defaults?.model ??
        runtimeModel(modelProviderSelection)
    );
}

function runtimeModel(modelProviderSelection: ModelProviderSelection): AbgNodeModelOptions {
    return {
        providerID: modelProviderSelection.providerID,
        modelID: modelProviderSelection.modelID,
    };
}

function nodeStatusForSignal(signal: AbgSignal): AbgNodeStatus {
    switch (signal.type) {
        case 'started':
        case 'progress':
        case 'emit':
        case 'select':
        case 'transition':
        case 'spawn':
        case 'cancel':
            return 'running';
        case 'success':
            return 'succeeded';
        case 'failure':
            return 'failed';
        case 'cancelled':
            return 'cancelled';
        default:
            return assertNever(signal);
    }
}

function edgePriorityDescending(
    left: { readonly priority?: number | undefined },
    right: { readonly priority?: number | undefined },
): number {
    return (right.priority ?? 0) - (left.priority ?? 0);
}

function assertNever(value: never): never {
    throw new Error(`Unhandled ABG signal: ${String(value)}`);
}
