import type { AbgNodeSpec, AbgPolicyDecision, AbgSignal, AgentEvent } from '@mission-control/protocol';
import type { AuthorableAbgGraph } from './authorable-graph';
import { evaluateApprovalGate } from './graph-approval-gates';
import { type CoordinatorState, findBlockingPolicy, nextAttempt, nodeModel } from './graph-coordinator-helpers';
import { runApprovedHumanApprovalNode, runNodeAttempt } from './graph-coordinator-node-execution';
import { attemptFailureError } from './graph-coordinator-node-signals';
import type { AbgGraphRunnerInput } from './graph-runner';
import { attemptEvent } from './graph-runner-events';
import type { ToolActionFingerprint } from './loop-safety';
import type { AbgNodeRegistry } from './node-registry';

export type QueuedNodeResult =
    | {
          readonly kind: 'completed';
          readonly node: AbgNodeSpec;
          readonly lastSignal?: AbgSignal;
          readonly lastEventType?: string;
          readonly lastPolicyDecision?: AbgPolicyDecision;
          readonly hadOnlyRetryableToolFailures?: boolean;
          readonly hadProductiveToolUse?: boolean;
          readonly toolActions?: readonly ToolActionFingerprint[];
      }
    | {
          readonly kind: 'failed';
          readonly node: AbgNodeSpec;
          readonly attempt: number;
          readonly lastSignal?: AbgSignal;
          readonly terminal?: boolean;
          readonly toolActions?: readonly ToolActionFingerprint[];
      }
    | {
          readonly kind: 'blocked';
          readonly node: AbgNodeSpec;
          readonly lastSignal?: AbgSignal;
          readonly trailingEvents?: readonly AgentEvent[];
      };

export async function runQueuedNode(
    graph: AuthorableAbgGraph,
    node: AbgNodeSpec,
    registry: AbgNodeRegistry,
    input: AbgGraphRunnerInput,
    state: CoordinatorState,
): Promise<QueuedNodeResult> {
    const policy = findBlockingPolicy(node, graph.policies);
    const gate = evaluateApprovalGate({ graphId: graph.id, node, ...(policy !== undefined ? { policy } : {}), input });
    if (gate.kind === 'blocked') {
        state.nodeStatuses[node.id] = 'blocked';
        const splitEvents = splitBlockedGateEvents(gate.events);
        state.events.push(...splitEvents.immediateEvents);
        return {
            kind: 'blocked',
            node,
            ...(splitEvents.trailingEvents.length > 0 ? { trailingEvents: splitEvents.trailingEvents } : {}),
        };
    }
    state.events.push(...gate.events);

    const attempt = nextAttempt(state.attemptsByNodeId, node.id);
    state.totalNodeRuns += 1;
    state.recentNodeIds.push(node.id);
    if (state.recentNodeIds.length > 24) {
        state.recentNodeIds.splice(0, state.recentNodeIds.length - 24);
    }
    const model = nodeModel(graph, node.id, input.modelProviderSelection);
    state.events.push(attemptEvent('attempt.started', graph.id, node, input, attempt, state.maxAttempts));
    const runResult = gate.approvedHumanApproval
        ? runApprovedHumanApprovalNode(graph, node, input, state, model, attempt)
        : await runNodeAttempt(graph, node, registry, input, state, model, attempt);
    if (runResult.status === 'failed') {
        state.events.push(
            attemptEvent(
                'attempt.failed',
                graph.id,
                node,
                input,
                attempt,
                state.maxAttempts,
                attemptFailureError(node, attempt, state.maxAttempts, runResult.terminal === true),
            ),
        );
        return {
            kind: 'failed',
            node,
            attempt,
            ...(runResult.lastSignal !== undefined ? { lastSignal: runResult.lastSignal } : {}),
            ...(runResult.terminal === true ? { terminal: true } : {}),
            ...(runResult.toolActions.length > 0 ? { toolActions: runResult.toolActions } : {}),
        };
    }
    if (runResult.status === 'blocked') {
        state.nodeStatuses[node.id] = 'blocked';
        return {
            kind: 'blocked',
            node,
            ...(runResult.lastSignal !== undefined ? { lastSignal: runResult.lastSignal } : {}),
        };
    }
    state.events.push(attemptEvent('attempt.completed', graph.id, node, input, attempt, state.maxAttempts));
    return {
        kind: 'completed',
        node,
        ...(runResult.lastSignal !== undefined ? { lastSignal: runResult.lastSignal } : {}),
        ...(runResult.lastEventType !== undefined ? { lastEventType: runResult.lastEventType } : {}),
        ...(runResult.lastPolicyDecision !== undefined ? { lastPolicyDecision: runResult.lastPolicyDecision } : {}),
        ...(runResult.hadOnlyRetryableToolFailures === true ? { hadOnlyRetryableToolFailures: true } : {}),
        ...(runResult.hadProductiveToolUse === true ? { hadProductiveToolUse: true } : {}),
        ...(runResult.toolActions.length > 0 ? { toolActions: runResult.toolActions } : {}),
    };
}

function splitBlockedGateEvents(events: readonly AgentEvent[]): {
    readonly immediateEvents: readonly AgentEvent[];
    readonly trailingEvents: readonly AgentEvent[];
} {
    return {
        immediateEvents: events.filter((event) => event.type !== 'graph.failed'),
        trailingEvents: events.filter((event) => event.type === 'graph.failed'),
    };
}
