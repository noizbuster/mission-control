import type { AbgNodeSpec, AbgPolicyDecision, AbgSignal } from '@mission-control/protocol';
import type { AuthorableAbgGraph } from './authorable-graph.js';
import { evaluateApprovalGate } from './graph-approval-gates.js';
import { type CoordinatorState, findBlockingPolicy, nextAttempt, nodeModel } from './graph-coordinator-helpers.js';
import { runApprovedHumanApprovalNode, runNodeAttempt } from './graph-coordinator-node-execution.js';
import { attemptFailureError } from './graph-coordinator-node-signals.js';
import type { AbgGraphRunnerInput } from './graph-runner.js';
import { attemptEvent } from './graph-runner-events.js';
import type { ToolActionFingerprint } from './loop-safety.js';
import type { AbgNodeRegistry } from './node-registry.js';

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
    | { readonly kind: 'blocked'; readonly lastSignal?: AbgSignal };

export async function runQueuedNode(
    graph: AuthorableAbgGraph,
    node: AbgNodeSpec,
    registry: AbgNodeRegistry,
    input: AbgGraphRunnerInput,
    state: CoordinatorState,
): Promise<QueuedNodeResult> {
    const policy = findBlockingPolicy(node, graph.policies);
    const gate = evaluateApprovalGate({ graphId: graph.id, node, ...(policy !== undefined ? { policy } : {}), input });
    state.events.push(...gate.events);
    if (gate.kind === 'blocked') return { kind: 'blocked' };

    const attempt = nextAttempt(state.attemptsByNodeId, node.id);
    state.totalNodeRuns += 1;
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
        return {
            kind: 'blocked',
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
