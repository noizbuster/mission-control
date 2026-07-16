import type {
    AbgNodeSpec,
    AbgPolicyDecision,
    AbgSignal,
    AgentEvent,
} from '@mission-control/protocol';
import { createAbgEmitSignal } from './abg-emit';
import type { AuthorableAbgGraph } from './authorable-graph';
import { buildCorrectionPayload } from './correction-payload';
import { CANONICAL_FAILURE_CODES } from './failure-taxonomy';
import { type CoordinatorState, hasNode, nodeModel } from './graph-coordinator-helpers';
import { failureCodeFromSignal } from './graph-coordinator-node-signals';
import type { AbgGraphRunnerInput, AbgGraphRunResult, AbgGraphTerminalError } from './graph-runner';
import { classifyRoutingProgress, isRoutingDeadEnd } from './routing-completeness';
import { projectAbgSignalToEvent } from './signals';

export type ProgressContractOutcome =
    | { readonly kind: 'fail'; readonly result: AbgGraphRunResult }
    | { readonly kind: 'continue' };

export type PostSuccessRoutingInput = {
    readonly graph: AuthorableAbgGraph;
    readonly node: AbgNodeSpec;
    readonly state: CoordinatorState;
    readonly runnerInput: AbgGraphRunnerInput;
    readonly failGraph: (
        code: string,
        message: string,
        terminalError?: AbgGraphTerminalError,
    ) => AbgGraphRunResult;
    readonly lastSignal?: AbgSignal;
    readonly lastEventType?: string;
    readonly lastPolicyDecision?: AbgPolicyDecision;
};

export function clearNodeCorrection(state: CoordinatorState, nodeId: string): void {
    state.correctionByNodeId.delete(nodeId);
}

export function clearAllCorrections(state: CoordinatorState): void {
    state.correctionByNodeId.clear();
}

export function setStructuredOutputCorrection(
    state: CoordinatorState,
    node: AbgNodeSpec,
    errorMessage: string | undefined,
): void {
    const allowedLabels = readOutputEnum(node);
    state.correctionByNodeId.set(
        node.id,
        buildCorrectionPayload({
            code: CANONICAL_FAILURE_CODES.INVALID_STRUCTURED_OUTPUT,
            ...(allowedLabels !== undefined ? { allowedLabels } : {}),
            booleanShape: isBooleanOutputShape(node),
            ...(errorMessage !== undefined ? { errorMessage } : {}),
        }),
    );
}

export function handlePostSuccessRouting(input: PostSuccessRoutingInput): ProgressContractOutcome {
    const { graph, node, lastSignal, state, runnerInput, failGraph } = input;
    const evaluationInput = {
        nodeStatuses: state.nodeStatuses,
        ...(lastSignal !== undefined ? { signalType: lastSignal.type } : {}),
        ...(input.lastEventType !== undefined ? { eventType: input.lastEventType } : {}),
        blackboard: state.blackboard.toRecord(),
        ...(input.lastPolicyDecision !== undefined ? { policyDecision: input.lastPolicyDecision } : {}),
    };
    const outboundEdges = graph.edges
        .filter((edge) => edge.source === node.id)
        .map((edge) => ({
            target: edge.target,
            ...(edge.condition !== undefined ? { condition: edge.condition } : {}),
        }));
    const selectTarget =
        lastSignal?.type === 'select' && typeof lastSignal.target === 'string' ? lastSignal.target : undefined;
    const classification = classifyRoutingProgress({
        ...(node.config !== undefined ? { nodeConfig: node.config } : {}),
        outboundEdges,
        ruleMatches: (ruleId) => {
            const rule = graph.compiledRules.find((candidate) => candidate.id === ruleId);
            return rule?.matches(evaluationInput) === true;
        },
        ...(selectTarget !== undefined ? { selectTarget } : {}),
        ...(selectTarget !== undefined ? { selectTargetExists: hasNode(graph, selectTarget) } : {}),
    });

    if (!isRoutingDeadEnd(classification)) {
        state.consecutiveFailuresByNodeId.set(node.id, 0);
        clearNodeCorrection(state, node.id);
        return { kind: 'continue' };
    }

    // Self-loop only (e.g. llm.loop_active): unmatched self-edges are intentional loop exit.
    // Dead-end requires at least one outbound edge targeting a different node.
    const hasPeerOutbound = outboundEdges.some((edge) => edge.target !== node.id);
    if (!hasPeerOutbound) {
        state.consecutiveFailuresByNodeId.set(node.id, 0);
        clearNodeCorrection(state, node.id);
        return { kind: 'continue' };
    }

    return admitRoutingDeadEnd({
        graph,
        node,
        state,
        runnerInput,
        failGraph,
    });
}

export function admitRoutingDeadEnd(input: {
    readonly graph: AuthorableAbgGraph;
    readonly node: AbgNodeSpec;
    readonly state: CoordinatorState;
    readonly runnerInput: AbgGraphRunnerInput;
    readonly failGraph: (
        code: string,
        message: string,
        terminalError?: AbgGraphTerminalError,
    ) => AbgGraphRunResult;
}): ProgressContractOutcome {
    const { graph, node, state, runnerInput, failGraph } = input;
    const consecutive = (state.consecutiveFailuresByNodeId.get(node.id) ?? 0) + 1;
    state.consecutiveFailuresByNodeId.set(node.id, consecutive);
    const attempt = state.attemptsByNodeId.get(node.id) ?? consecutive;

    emitRoutingDeadEndEvent({
        graph,
        node,
        state,
        runnerInput,
        attempt,
    });

    const outputKey = readOutputKey(node);
    const observedValue =
        outputKey !== undefined && state.blackboard.has(outputKey) ? state.blackboard.get(outputKey) : undefined;
    const allowedLabels = readOutputEnum(node);
    state.correctionByNodeId.set(
        node.id,
        buildCorrectionPayload({
            code: CANONICAL_FAILURE_CODES.ROUTING_DEAD_END,
            ...(allowedLabels !== undefined ? { allowedLabels } : {}),
            booleanShape: isBooleanOutputShape(node),
            errorMessage: 'no outbound edge matched',
            ...(observedValue !== undefined ? { observedValue } : {}),
        }),
    );
    if (outputKey !== undefined) {
        state.blackboard.delete(outputKey);
    }

    if (consecutive < state.maxAttempts) {
        state.queuedNodeIds.unshift(node.id);
        return { kind: 'continue' };
    }

    const escalation = resolveEscalationTarget(node, graph);
    if (escalation !== undefined && hasNode(graph, escalation)) {
        clearNodeCorrection(state, node.id);
        state.queuedNodeIds.push(escalation);
        return { kind: 'continue' };
    }

    clearAllCorrections(state);
    return {
        kind: 'fail',
        result: failGraph(
            CANONICAL_FAILURE_CODES.ROUTING_DEAD_END,
            `ABG routing dead-end exhausted for node: ${node.id}`,
            {
                code: CANONICAL_FAILURE_CODES.ROUTING_DEAD_END,
                message: `no outbound edge matched after ${consecutive} attempts: ${node.id}`,
                retryable: false,
            },
        ),
    };
}

export function handleStructuredFailureExhaust(input: {
    readonly graph: AuthorableAbgGraph;
    readonly node: AbgNodeSpec;
    readonly state: CoordinatorState;
    readonly failGraph: (
        code: string,
        message: string,
        terminalError?: AbgGraphTerminalError,
    ) => AbgGraphRunResult;
    readonly lastSignal?: AbgSignal;
}): ProgressContractOutcome | undefined {
    const code = failureCodeFromSignal(input.lastSignal);
    if (code !== CANONICAL_FAILURE_CODES.INVALID_STRUCTURED_OUTPUT) {
        return undefined;
    }
    const escalation = resolveEscalationTarget(input.node, input.graph);
    if (escalation !== undefined && hasNode(input.graph, escalation)) {
        clearNodeCorrection(input.state, input.node.id);
        input.state.queuedNodeIds.push(escalation);
        return { kind: 'continue' };
    }
    return undefined;
}

export function resolveEscalationTarget(node: AbgNodeSpec, graph: AuthorableAbgGraph): string | undefined {
    const fromNode = node.config?.['escalationTarget'];
    if (typeof fromNode === 'string' && fromNode.length > 0) {
        return fromNode;
    }
    const fromDefaults = graph.defaults?.escalationTarget;
    if (typeof fromDefaults === 'string' && fromDefaults.length > 0) {
        return fromDefaults;
    }
    return undefined;
}

function emitRoutingDeadEndEvent(input: {
    readonly graph: AuthorableAbgGraph;
    readonly node: AbgNodeSpec;
    readonly state: CoordinatorState;
    readonly runnerInput: AbgGraphRunnerInput;
    readonly attempt: number;
}): void {
    const signal = createAbgEmitSignal({
        graphId: input.graph.id,
        nodeId: input.node.id,
        source: 'graph-coordinator',
        eventType: 'routing.dead_end',
        timestamp: input.runnerInput.now(),
        payload: {
            nodeId: input.node.id,
            code: CANONICAL_FAILURE_CODES.ROUTING_DEAD_END,
            attempt: input.attempt,
        },
    });
    const event: AgentEvent = projectAbgSignalToEvent({
        graphId: input.graph.id,
        sessionId: input.runnerInput.sessionId,
        timestamp: input.runnerInput.now(),
        signal,
        nodeKind: input.node.kind,
        model: nodeModel(input.graph, input.node.id, input.runnerInput.modelProviderSelection),
        attempt: input.attempt,
        maxAttempts: input.state.maxAttempts,
        observabilityRedactor: input.state.observabilityRedactor,
    });
    input.state.events.push(event);
}

function readOutputKey(node: AbgNodeSpec): string | undefined {
    const value = node.config?.['outputKey'];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readOutputEnum(node: AbgNodeSpec): readonly string[] | undefined {
    const raw = node.config?.['outputEnum'];
    if (!Array.isArray(raw)) {
        return undefined;
    }
    const labels = raw.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
    return labels.length > 0 ? labels : undefined;
}

function isBooleanOutputShape(node: AbgNodeSpec): boolean {
    return node.config?.['outputShape'] === 'boolean';
}
