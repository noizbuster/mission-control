import type { AbgNodeSpec, AbgPolicyDecision, AbgSignal, AgentEvent } from '@mission-control/protocol';
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
import type { AbgGraphRunnerInput, AbgGraphRunResult, AbgGraphTerminalError } from './graph-runner.js';
import { graphEvent } from './graph-runner-events.js';
import { createDefaultAbgNodeRegistry } from './node-registry.js';
import { projectAbgSignalToEvent } from './signals.js';

export async function runBoundedAbgGraph(input: AbgGraphRunnerInput): Promise<AbgGraphRunResult> {
    const graph = createAuthorableAbgGraph(input.graph, input.agentModelLookup);
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
                    if (result.lastSignal?.type === 'escalate') {
                        // Escalation is a non-terminal redirect (ABG §9.6 supervision). Prefer
                        // the escalate signal's own `target`; fall back to node config.
                        const signalTarget = result.lastSignal.target;
                        const target =
                            (typeof signalTarget === 'string' && signalTarget.length > 0 ? signalTarget : undefined) ??
                            readEscalationTarget(result.node);
                        if (target !== undefined && hasNode(graph, target)) {
                            state.queuedNodeIds.push(target);
                        } else {
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
                            return failGraph(
                                graph.id,
                                input,
                                state.events,
                                'node_retry_exhausted',
                                `ABG node retry limit exhausted on consecutive tool failures: ${result.node.id}`,
                                terminalErrorFromSignal(result.lastSignal),
                            );
                        }
                    } else if (result.hadProductiveToolUse === true) {
                        state.consecutiveToolFailuresByNodeId.set(result.node.id, 0);
                    }
                    state.consecutiveFailuresByNodeId.set(result.node.id, 0);
                    enqueueSelectedTargets(
                        graph,
                        result.node,
                        result.lastSignal,
                        state,
                        input,
                        result.lastEventType,
                        result.lastPolicyDecision,
                    );
                    break;
                case 'failed': {
                    // A terminal tool-settlement failure (a `command_not_allowed` under
                    // `haltOnFailedToolSettlement`) is non-retryable: the model cannot fix it by
                    // re-running, so fail the run immediately instead of consuming the retry
                    // budget. Parity with the flat run coordinator's fail-fast on a terminal
                    // tool settlement. A denial is NOT terminal — the LLMActor surfaces it to the
                    // model so the run can adapt. The toolCallId travels on the run's tool.failed
                    // event (set via the adapter), so it surfaces on `session.stopped` without
                    // threading it here.
                    if (result.terminal === true) {
                        return failGraph(
                            graph.id,
                            input,
                            state.events,
                            'tool_settlement_failed',
                            `ABG run failed on a non-retryable tool settlement: ${result.node.id}`,
                            terminalErrorFromSignal(result.lastSignal),
                        );
                    }
                    const consecutiveFailures = (state.consecutiveFailuresByNodeId.get(result.node.id) ?? 0) + 1;
                    state.consecutiveFailuresByNodeId.set(result.node.id, consecutiveFailures);
                    if (consecutiveFailures < state.maxAttempts) {
                        state.queuedNodeIds.unshift(result.node.id);
                        break;
                    }
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

function readEscalationTarget(node: AbgNodeSpec): string | undefined {
    const value = node.config?.['escalationTarget'];
    return typeof value === 'string' && value.length > 0 ? value : undefined;
}
