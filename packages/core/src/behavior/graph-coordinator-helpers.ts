import type {
    AbgNodeModelOptions,
    AbgNodeSpec,
    AbgNodeStatus,
    AbgPolicySpec,
    AbgSignal,
    AgentEvent,
    ModelProviderSelection,
} from '@mission-control/protocol';
import type { Blackboard } from '../memory/blackboard.js';
import { createBlackboard } from '../memory/blackboard.js';
import {
    createObservabilityRedactor,
    type ObservabilityRedactor,
} from '../providers/observability-redactor.js';
import { createAbgEmitSignal, resetEmitSequence } from './abg-emit.js';
import type { AuthorableAbgGraph } from './authorable-graph.js';
import type { CostLedger } from './budget/cost-ledger.js';
import { createCostLedger } from './budget/cost-ledger.js';
import type { AbgGraphRunnerInput } from './graph-runner.js';
import type { LoopSafetyNodeState } from './loop-safety.js';
import { projectAbgSignalToEvent } from './signals.js';

const defaultRetryLimit = 2;
const defaultMaxNodeRuns = 48;
const defaultGraphNodeConcurrency = 2;
const defaultProviderToolCallConcurrency = 4;
const defaultShellConcurrency = 1;

export type CoordinatorState = {
    readonly events: AgentEvent[];
    readonly nodeStatuses: Record<string, AbgNodeStatus | undefined>;
    readonly queuedNodeIds: string[];
    readonly attemptsByNodeId: Map<string, number>;
    readonly consecutiveFailuresByNodeId: Map<string, number>;
    readonly consecutiveToolFailuresByNodeId: Map<string, number>;
    /** Per-node identical-turn / identical-failure detectors (infinite-loop safety). */
    readonly loopSafetyByNodeId: Map<string, LoopSafetyNodeState>;
    readonly maxAttempts: number;
    readonly maxNodeRuns: number;
    readonly graphNodeConcurrency: number;
    readonly providerToolCallConcurrency: number;
    readonly shellConcurrency: number;
    totalNodeRuns: number;
    /**
     * The live Blackboard. One instance per run, shared (by reference) with every node
     * via `AbgNodeRunContext`. Seeded with `initialMessages`. Rule-gated re-entry edges
     * read its entries via `blackboard.*` predicates (`toRecord()`).
     */
    readonly blackboard: Blackboard;
    /**
     * Per-run cost ledger for `usage → policy.budget.*` events. Undefined when neither a
     * budget ceiling nor a pricing table is configured (the common no-cost case).
     */
    readonly budgetLedger?: CostLedger;
    readonly observabilityRedactor: ObservabilityRedactor;
};

export function createCoordinatorState(graph: AuthorableAbgGraph, input: AbgGraphRunnerInput): CoordinatorState {
    // Reset the node-level emit counter for this graph so each run begins the id sequence
    // at 1 — making sequential runs of the same graph byte-identical (review #9).
    resetEmitSequence(graph.id);
    // The blackboard mutation observer needs to push events into state.events, but state is
    // constructed from the blackboard. Deferred via a holder so the closure captures a stable
    // reference that is populated once state is built.
    let stateHolder: CoordinatorState | undefined;
    const observabilityRedactor = input.observabilityRedactor ?? createObservabilityRedactor();
    const blackboard = createBlackboard({
        onMutation: (kind, payload) => {
            if (stateHolder === undefined) return;
            const signal = createAbgEmitSignal({
                graphId: graph.id,
                nodeId: '$blackboard',
                eventType: kind,
                timestamp: input.now(),
                ...(payload.value !== undefined ? { payload } : {}),
            });
            stateHolder.events.push(
                projectAbgSignalToEvent({
                    graphId: graph.id,
                    sessionId: input.sessionId,
                    timestamp: input.now(),
                    signal,
                    observabilityRedactor,
                }),
            );
        },
    });
    if (input.initialMessages !== undefined) {
        blackboard.setMessages(input.initialMessages);
    }
    const budgetCents = graph.defaults?.model?.budgetCents;
    const budgetLedger = createCostLedger({
        ...(input.pricingTable !== undefined ? { pricingTable: input.pricingTable } : {}),
        ...(budgetCents !== undefined ? { budget: { budgetCents } } : {}),
    });
    const state: CoordinatorState = {
        events: [],
        nodeStatuses: {},
        queuedNodeIds: [graph.entryNodeId],
        attemptsByNodeId: new Map(),
        consecutiveFailuresByNodeId: new Map(),
        consecutiveToolFailuresByNodeId: new Map(),
        loopSafetyByNodeId: new Map(),
        maxAttempts: (graph.defaults?.retryLimit ?? defaultRetryLimit) + 1,
        maxNodeRuns: graph.defaults?.maxNodeRuns ?? input.maxNodeRuns ?? defaultMaxNodeRuns,
        graphNodeConcurrency: input.graphNodeConcurrency ?? defaultGraphNodeConcurrency,
        providerToolCallConcurrency: input.providerToolCallConcurrency ?? defaultProviderToolCallConcurrency,
        shellConcurrency: input.shellConcurrency ?? defaultShellConcurrency,
        totalNodeRuns: 0,
        blackboard,
        observabilityRedactor,
        ...(budgetLedger !== undefined ? { budgetLedger } : {}),
    };
    stateHolder = state;
    return state;
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
        case 'fallback':
            return 'running';
        case 'success':
            return 'succeeded';
        case 'failure':
        case 'escalate':
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
        ...(modelProviderSelection.variantID !== undefined ? { variantID: modelProviderSelection.variantID } : {}),
    };
}

function assertNever(value: never): never {
    throw new Error(`Unhandled ABG signal: ${String(value)}`);
}
