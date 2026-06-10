import type {
    AbgNodeModelOptions,
    AbgNodeSpec,
    AbgNodeStatus,
    AbgPolicySpec,
    AbgSignal,
    AgentEvent,
    ModelProviderSelection,
} from '@mission-control/protocol';
import type { AuthorableAbgGraph } from './authorable-graph.js';
import type { AbgGraphRunnerInput } from './graph-runner.js';
import type { AbgNodeRegistry, AbgObservedGraphEvent } from './node-registry.js';

const defaultRetryLimit = 2;
const defaultMaxNodeRuns = 32;
const defaultGraphNodeConcurrency = 2;
const defaultProviderToolCallConcurrency = 4;
const defaultShellConcurrency = 1;

export type CoordinatorState = {
    readonly events: AgentEvent[];
    readonly nodeStatuses: Record<string, AbgNodeStatus | undefined>;
    readonly queuedNodeIds: string[];
    readonly attemptsByNodeId: Map<string, number>;
    readonly maxAttempts: number;
    readonly maxNodeRuns: number;
    readonly graphNodeConcurrency: number;
    readonly providerToolCallConcurrency: number;
    readonly shellConcurrency: number;
    totalNodeRuns: number;
};

export function createCoordinatorState(graph: AuthorableAbgGraph, input: AbgGraphRunnerInput): CoordinatorState {
    return {
        events: [],
        nodeStatuses: {},
        queuedNodeIds: [graph.entryNodeId],
        attemptsByNodeId: new Map(),
        maxAttempts: (graph.defaults?.retryLimit ?? defaultRetryLimit) + 1,
        maxNodeRuns: graph.defaults?.maxNodeRuns ?? input.maxNodeRuns ?? defaultMaxNodeRuns,
        graphNodeConcurrency: input.graphNodeConcurrency ?? defaultGraphNodeConcurrency,
        providerToolCallConcurrency: input.providerToolCallConcurrency ?? defaultProviderToolCallConcurrency,
        shellConcurrency: input.shellConcurrency ?? defaultShellConcurrency,
        totalNodeRuns: 0,
    };
}

export function runContext(graph: AuthorableAbgGraph, registry: AbgNodeRegistry, input: AbgGraphRunnerInput) {
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

export function nextAttempt(attemptsByNodeId: Map<string, number>, nodeId: string): number {
    const next = (attemptsByNodeId.get(nodeId) ?? 0) + 1;
    attemptsByNodeId.set(nodeId, next);
    return next;
}

export function findNode(graph: AuthorableAbgGraph, nodeId: string): AbgNodeSpec {
    const node = graph.nodes.find((candidate) => candidate.id === nodeId);
    if (node === undefined) {
        throw new Error(`Unknown ABG graph node: ${nodeId}`);
    }
    return node;
}

export function hasNode(graph: AuthorableAbgGraph, nodeId: string): boolean {
    return graph.nodes.some((node) => node.id === nodeId);
}

export function findBlockingPolicy(node: AbgNodeSpec, policies: readonly AbgPolicySpec[]): AbgPolicySpec | undefined {
    return policies.find(
        (policy) => policy.decision !== 'allow' && (node.capabilities ?? []).includes(policy.capability),
    );
}

export function nodeModel(
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

export function nodeStatusForSignal(signal: AbgSignal): AbgNodeStatus {
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

export function edgePriorityDescending(
    left: { readonly priority?: number | undefined },
    right: { readonly priority?: number | undefined },
): number {
    return (right.priority ?? 0) - (left.priority ?? 0);
}

function runtimeModel(modelProviderSelection: ModelProviderSelection): AbgNodeModelOptions {
    return {
        providerID: modelProviderSelection.providerID,
        modelID: modelProviderSelection.modelID,
    };
}

function assertNever(value: never): never {
    throw new Error(`Unhandled ABG signal: ${String(value)}`);
}
