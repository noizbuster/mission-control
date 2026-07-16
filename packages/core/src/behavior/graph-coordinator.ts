// allow: SIZE_OK -- HEAD 410 -> current 477 pure LOC; one bounded graph execution state machine (progress-contract wire).
import type { AbgNodeSpec, AbgPolicyDecision, AbgSignal, AgentEvent } from '@mission-control/protocol';
import { type AuthorableAbgGraph, createAuthorableAbgGraph } from './authorable-graph';
import {
    type CoordinatorState,
    createCoordinatorState,
    edgePriorityDescending,
    hasNode,
    nodeModel,
} from './graph-coordinator-helpers';
import { runQueuedNode } from './graph-coordinator-node-runner';
import {
    clearAllCorrections,
    clearNodeCorrection,
    handlePostSuccessRouting,
    handleStructuredFailureExhaust,
    setStructuredOutputCorrection,
} from './graph-coordinator-progress-contract';
import { failureCodeFromSignal, failureMessageFromSignal } from './graph-coordinator-node-signals';
import { scheduleQueuedNodes } from './graph-coordinator-scheduler';
import type { AbgGraphRunnerInput, AbgGraphRunResult, AbgGraphTerminalError } from './graph-runner';
import { graphEvent } from './graph-runner-events';
import {
    createLoopSafetyNodeState,
    type LoopSafetyTrip,
    recordFailureTurn,
    recordToolTurn,
    type ToolActionFingerprint,
} from './loop-safety';
import { createDefaultAbgNodeRegistry } from './node-registry';
import { projectAbgSignalToEvent } from './signals';
import { CANONICAL_FAILURE_CODES } from './failure-taxonomy';

export async function runBoundedAbgGraph(input: AbgGraphRunnerInput): Promise<AbgGraphRunResult> {
    const graph = createAuthorableAbgGraph(input.graph, input.agentModelLookup);
    const registry = input.registry ?? createDefaultAbgNodeRegistry();
    const state = createCoordinatorState(graph, input);

    state.events.push(graphEvent('graph.started', graph.id, input, 'ABG graph started'));
    while (state.queuedNodeIds.length > 0) {
        // `provider_aborted` is retryable in isTerminalToolFailureError, so without this gate a
        // user cancel would re-enqueue the node up to maxAttempts before the loop noticed. The
        // turn runner maps any aborted run to `interrupted` regardless of how we settle here.
        if (input.abortSignal?.aborted === true) {
            clearAllCorrections(state);
            return failGraph(
                graph.id,
                input,
                state.events,
                'provider_aborted',
                'ABG graph aborted by run-owner signal',
                { code: 'provider_aborted', message: 'run-owner signal aborted', retryable: false },
            );
        }
        if (state.totalNodeRuns >= state.maxNodeRuns) {
            clearAllCorrections(state);
            return failGraph(graph.id, input, state.events, 'graph_loop_limit', 'ABG graph loop limit exceeded');
        }
        const scheduledNodes = scheduleQueuedNodes(graph, state, input);
        if (scheduledNodes.length === 0) {
            clearAllCorrections(state);
            return failGraph(graph.id, input, state.events, 'graph_loop_limit', 'ABG graph made no progress');
        }
        const results = await Promise.all(
            scheduledNodes.map((node) => runQueuedNode(graph, node, registry, input, state)),
        );
        for (const result of results) {
            switch (result.kind) {
                case 'completed': {
                    if (result.lastSignal?.type === 'escalate') {
                        // Escalation is a non-terminal redirect (ABG §9.6 supervision). Prefer
                        // the escalate signal's own `target`; fall back to node config.
                        const signalTarget = result.lastSignal.target;
                        const target =
                            (typeof signalTarget === 'string' && signalTarget.length > 0 ? signalTarget : undefined) ??
                            readEscalationTarget(result.node);
                        clearNodeCorrection(state, result.node.id);
                        if (target !== undefined && hasNode(graph, target)) {
                            state.queuedNodeIds.push(target);
                        } else {
                            clearAllCorrections(state);
                            return failGraph(
                                graph.id,
                                input,
                                state.events,
                                'node_escalated',
                                `ABG node escalated without a reachable target: ${result.node.id}`,
                            );
                        }
                        break;
                    }
                    if (result.hadOnlyRetryableToolFailures === true) {
                        const consecutive = (state.consecutiveToolFailuresByNodeId.get(result.node.id) ?? 0) + 1;
                        state.consecutiveToolFailuresByNodeId.set(result.node.id, consecutive);
                        if (consecutive >= state.maxAttempts) {
                            clearAllCorrections(state);
                            return failGraph(
                                graph.id,
                                input,
                                state.events,
                                'node_retry_exhausted',
                                `ABG node retry limit exhausted on consecutive tool failures: ${result.node.id}`,
                                terminalErrorFromSignal(result.lastSignal),
                            );
                        }
                        const failureTrip = applyLoopSafetyFailure(
                            result.node.id,
                            state,
                            result.toolActions ?? [],
                            nodeFailureSignature(result.lastSignal),
                        );
                        if (failureTrip?.kind === 'fail') {
                            clearAllCorrections(state);
                            return failGraph(
                                graph.id,
                                input,
                                state.events,
                                failureTrip.code,
                                `ABG node ${result.node.id}: ${failureTrip.message}`,
                                {
                                    code: failureTrip.code,
                                    message: failureTrip.message,
                                    retryable: false,
                                },
                            );
                        }
                    }
                    let softLanded = false;
                    if (result.hadProductiveToolUse === true) {
                        // Productive tool use is progress unless the *same* tool turn repeats.
                        state.consecutiveToolFailuresByNodeId.set(result.node.id, 0);
                        const trip = applyLoopSafetyToolTurn(result.node.id, state, result.toolActions ?? []);
                        if (trip?.kind === 'soft_land') {
                            softLandToolLoop(result.node, state, graph.id, input, trip);
                            softLanded = true;
                        } else {
                            softLanded = softLandToolLoopIfNearMaxNodeRuns(
                                result.node,
                                state,
                                graph.id,
                                input,
                            );
                        }
                    }
                    enqueueSelectedTargets(
                        graph,
                        result.node,
                        result.lastSignal,
                        state,
                        input,
                        result.lastEventType,
                        result.lastPolicyDecision,
                    );
                    if (softLanded) {
                        // Loop soft-land is an intentional stop (clear loop_active); do not
                        // treat the resulting conditional miss as routing_dead_end.
                        state.consecutiveFailuresByNodeId.set(result.node.id, 0);
                        clearNodeCorrection(state, result.node.id);
                    } else {
                        const routingOutcome = handlePostSuccessRouting({
                            graph,
                            node: result.node,
                            state,
                            runnerInput: input,
                            failGraph: (code, message, terminalError) =>
                                failGraph(graph.id, input, state.events, code, message, terminalError),
                            ...(result.lastSignal !== undefined ? { lastSignal: result.lastSignal } : {}),
                            ...(result.lastEventType !== undefined
                                ? { lastEventType: result.lastEventType }
                                : {}),
                            ...(result.lastPolicyDecision !== undefined
                                ? { lastPolicyDecision: result.lastPolicyDecision }
                                : {}),
                        });
                        if (routingOutcome.kind === 'fail') {
                            return routingOutcome.result;
                        }
                    }
                    break;
                }
                case 'failed': {
                    // Fail explicit non-retryable provider errors and terminal tool settlements
                    // immediately instead of consuming the graph retry budget. A denial is NOT
                    // terminal — the LLMActor surfaces it to the model so the run can adapt. The
                    // toolCallId travels on the run's tool.failed event (set via the adapter), so it
                    // surfaces on `session.stopped` without threading it here.
                    if (result.terminal === true) {
                        clearAllCorrections(state);
                        const terminalError = terminalErrorFromSignal(result.lastSignal);
                        const isToolSettlement = terminalError?.code === 'tool_settlement_failed';
                        return failGraph(
                            graph.id,
                            input,
                            state.events,
                            terminalError?.code ?? 'node_failed',
                            isToolSettlement
                                ? `ABG run failed on a non-retryable tool settlement: ${result.node.id}`
                                : `ABG run failed on a non-retryable provider error: ${result.node.id}`,
                            terminalError,
                        );
                    }
                    // Node-level retries stay on consecutiveFailures / maxAttempts.
                    // Identical failure-combination detection applies to completed tool-failure
                    // turns (above), not here — otherwise it races node_retry_exhausted.
                    const consecutiveFailures = (state.consecutiveFailuresByNodeId.get(result.node.id) ?? 0) + 1;
                    state.consecutiveFailuresByNodeId.set(result.node.id, consecutiveFailures);
                    if (consecutiveFailures < state.maxAttempts) {
                        if (failureCodeFromSignal(result.lastSignal) === CANONICAL_FAILURE_CODES.INVALID_STRUCTURED_OUTPUT) {
                            setStructuredOutputCorrection(
                                state,
                                result.node,
                                failureMessageFromSignal(result.lastSignal),
                            );
                        }
                        state.queuedNodeIds.unshift(result.node.id);
                        break;
                    }
                    const structuredExhaust = handleStructuredFailureExhaust({
                        graph,
                        node: result.node,
                        state,
                        ...(result.lastSignal !== undefined ? { lastSignal: result.lastSignal } : {}),
                        failGraph: (code, message, terminalError) =>
                            failGraph(graph.id, input, state.events, code, message, terminalError),
                    });
                    if (structuredExhaust?.kind === 'continue') {
                        break;
                    }
                    if (structuredExhaust?.kind === 'fail') {
                        return structuredExhaust.result;
                    }
                    clearAllCorrections(state);
                    return failGraph(
                        graph.id,
                        input,
                        state.events,
                        'node_retry_exhausted',
                        `ABG node retry limit exhausted: ${result.node.id}`,
                        terminalErrorFromSignal(result.lastSignal),
                    );
                }
                case 'blocked': {
                    // A node settled as blocked — currently only the LLMActor approval-block
                    // short-circuit reaches here. Surface the toolCallId/reason off the terminal
                    // failure signal so the graph result carries them and the turn-runner mapping
                    // can thread the toolCallId into the `blocked_on_approval` result (parity with
                    // the flat run coordinator).
                    const block = approvalBlockContext(result.lastSignal);
                    return {
                        graphId: graph.id,
                        status: 'blocked',
                        events: state.events,
                        ...(block.toolCallId !== undefined ? { toolCallId: block.toolCallId } : {}),
                        ...(block.reason !== undefined ? { reason: block.reason } : {}),
                    };
                }
                default:
                    return assertNeverQueuedNodeResult(result);
            }
        }
    }

    state.events.push(graphEvent('graph.completed', graph.id, input, 'ABG graph completed'));
    return {
        graphId: graph.id,
        status: 'completed',
        events: state.events,
        finalMessages: state.blackboard.getMessages(),
    };
}

function enqueueSelectedTargets(
    graph: AuthorableAbgGraph,
    node: AbgNodeSpec,
    signal: AbgSignal | undefined,
    state: CoordinatorState,
    input: AbgGraphRunnerInput,
    lastEventType: string | undefined,
    lastPolicyDecision: AbgPolicyDecision | undefined,
): void {
    if (signal?.type === 'select' && hasNode(graph, signal.target)) {
        state.queuedNodeIds.push(signal.target);
    }
    for (const edge of graph.edges.filter((candidate) => candidate.source === node.id).sort(edgePriorityDescending)) {
        const rule =
            edge.condition === undefined
                ? undefined
                : graph.compiledRules.find((candidate) => candidate.id === edge.condition);
        // Runtime-condition edges: feed THIS node's last emitted event type, the live
        // Blackboard, and its last policy decision (carried per-result, so concurrent
        // node runs don't clobber each other) so rule-gated re-entry edges
        // (`event.type.equals` / `blackboard.*` / `policy.decision.equals`) can express
        // the Observe→Decide→Act loop ("tool calls remain", "critic failed", "asked").
        const evaluationInput = {
            nodeStatuses: state.nodeStatuses,
            ...(signal !== undefined ? { signalType: signal.type } : {}),
            ...(lastEventType !== undefined ? { eventType: lastEventType } : {}),
            blackboard: state.blackboard.toRecord(),
            ...(lastPolicyDecision !== undefined ? { policyDecision: lastPolicyDecision } : {}),
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
                nodeKind: node.kind,
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
    terminalError?: AbgGraphTerminalError,
): AbgGraphRunResult {
    const eventMessage =
        terminalError !== undefined && terminalError.message.length > 0
            ? `${message} — ${terminalError.message}`
            : message;
    events.push(graphFailureEvent(graphId, input, code, eventMessage));
    return { graphId, status: 'failed', events, ...(terminalError !== undefined ? { terminalError } : {}) };
}

/**
 * Pull a structured provider error off a terminal `failure` signal so the run result can carry the
 * `code` (e.g. `provider_aborted`). Nodes that surface a provider error put `{ message, code }` in
 * the failure signal's `error` field; other failures carry a plain string. Returns `undefined` when
 * the signal carries no recognizable code.
 */
function terminalErrorFromSignal(signal: AbgSignal | undefined): AbgGraphTerminalError | undefined {
    if (signal === undefined || signal.type !== 'failure') {
        return undefined;
    }
    const error = signal.error;
    if (typeof error === 'object' && error !== null && hasField(error, 'code') && typeof error.code === 'string') {
        const code = error.code;
        const message = hasField(error, 'message') && typeof error.message === 'string' ? error.message : code;
        const retryable =
            hasField(error, 'retryable') && typeof error.retryable === 'boolean' ? error.retryable : false;
        return { code, message, retryable };
    }
    return undefined;
}

function hasField<T extends string>(value: object, field: T): value is Record<T, unknown> {
    return field in value;
}

/**
 * Pull the approval-block context (toolCallId + reason) off a terminal `failure` signal emitted by
 * the LLMActor when a tool settled `approval_required`. The signal's `error` is the structured
 * `tool_approval_blocked` object the actor builds; `in`/`typeof` narrowing recovers the fields
 * without a cast. Returns empty for non-approval-block signals.
 */
function approvalBlockContext(signal: AbgSignal | undefined): {
    readonly toolCallId?: string;
    readonly reason?: string;
} {
    if (signal === undefined || signal.type !== 'failure') {
        return {};
    }
    const error = signal.error;
    if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== 'tool_approval_blocked') {
        return {};
    }
    const toolCallId = 'toolCallId' in error && typeof error.toolCallId === 'string' ? error.toolCallId : undefined;
    const reason = 'message' in error && typeof error.message === 'string' ? error.message : undefined;
    const context: { toolCallId?: string; reason?: string } = {};
    if (toolCallId !== undefined) {
        context.toolCallId = toolCallId;
    }
    if (reason !== undefined) {
        context.reason = reason;
    }
    return context;
}

function graphFailureEvent(graphId: string, input: AbgGraphRunnerInput, code: string, message: string): AgentEvent {
    return graphEvent('graph.failed', graphId, input, message, {
        error: { code, message, retryable: false },
    });
}

function assertNeverQueuedNodeResult(result: never): never {
    throw new Error(`Unhandled queued node result: ${String(result)}`);
}

function loopSafetyState(nodeId: string, state: CoordinatorState) {
    let entry = state.loopSafetyByNodeId.get(nodeId);
    if (entry === undefined) {
        entry = createLoopSafetyNodeState();
        state.loopSafetyByNodeId.set(nodeId, entry);
    }
    return entry;
}

function applyLoopSafetyToolTurn(
    nodeId: string,
    state: CoordinatorState,
    actions: readonly ToolActionFingerprint[],
): LoopSafetyTrip | undefined {
    return recordToolTurn(loopSafetyState(nodeId, state), actions);
}

function applyLoopSafetyFailure(
    nodeId: string,
    state: CoordinatorState,
    actions: readonly ToolActionFingerprint[],
    fallbackSignature?: string,
): LoopSafetyTrip | undefined {
    return recordFailureTurn(loopSafetyState(nodeId, state), actions, undefined, fallbackSignature);
}

function nodeFailureSignature(signal: AbgSignal | undefined): string | undefined {
    if (signal === undefined || signal.type !== 'failure') {
        return undefined;
    }
    const error = signal.error;
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
        return `node:${error.code}`;
    }
    if (typeof error === 'string' && error.length > 0) {
        return `node:${error}`;
    }
    return 'node:failure';
}

function softLandToolLoopIfNearMaxNodeRuns(
    node: AbgNodeSpec,
    state: CoordinatorState,
    graphId: string,
    input: AbgGraphRunnerInput,
): boolean {
    if (state.blackboard.get('llm.loop_active') !== true) {
        return false;
    }
    if (state.totalNodeRuns < state.maxNodeRuns - 1) {
        return false;
    }
    softLandToolLoop(node, state, graphId, input, {
        eventCode: 'node_loop_soft_landed',
        message: `soft-landed at maxNodeRuns ${state.maxNodeRuns}`,
    });
    return true;
}

function softLandToolLoop(
    node: AbgNodeSpec,
    state: CoordinatorState,
    graphId: string,
    input: AbgGraphRunnerInput,
    trip: LoopSafetyTrip | { readonly eventCode: string; readonly message: string },
): void {
    state.blackboard.set('llm.loop_active', false);
    forceCompleteBooleanOutputKey(node, state);
    const eventCode =
        'eventCode' in trip
            ? trip.eventCode
            : trip.kind === 'soft_land'
              ? trip.code === 'oscillating_tool_pattern'
                  ? 'node_oscillating_tool_pattern'
                  : 'node_repeated_tool_pattern'
              : trip.code;
    const message = trip.message;
    state.events.push({
        type: 'node.failed',
        timestamp: input.now(),
        sessionId: input.sessionId,
        message: `ABG node soft-landed: ${node.id} — ${message}`,
        durability: 'durable',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
        abg: {
            graphId,
            nodeId: node.id,
            signalType: 'fallback',
            error: {
                code: eventCode,
                message,
                retryable: false,
            },
        },
    });
}

function forceCompleteBooleanOutputKey(node: AbgNodeSpec, state: CoordinatorState): void {
    const outputKey = node.config?.['outputKey'];
    if (typeof outputKey !== 'string' || outputKey.length === 0) {
        return;
    }
    if (node.config?.['outputShape'] !== 'boolean') {
        return;
    }
    if (state.blackboard.get(outputKey) === true) {
        return;
    }
    state.blackboard.set(outputKey, true);
}

function readEscalationTarget(node: AbgNodeSpec): string | undefined {
    const value = node.config?.['escalationTarget'];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
