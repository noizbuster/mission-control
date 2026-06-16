import {
    type AbgNodeModelOptions,
    type AbgNodeSpec,
    type AbgPolicyDecision,
    AbgPolicyDecisionSchema,
    type AbgRuntimeError,
    type AbgSignal,
} from '@mission-control/protocol';
import type { AuthorableAbgGraph } from './authorable-graph.js';
import { evaluateApprovalGate } from './graph-approval-gates.js';
import {
    type CoordinatorState,
    findBlockingPolicy,
    nextAttempt,
    nodeModel,
    nodeStatusForSignal,
    runContext,
} from './graph-coordinator-helpers.js';
import type { AbgGraphRunnerInput } from './graph-runner.js';
import { attemptEvent, modelCallEvent, toolLifecycleEvent } from './graph-runner-events.js';
import type { AbgNodeRegistry } from './node-registry.js';
import { runAbgNode } from './node-registry.js';
import { projectAbgSignalToEvent } from './signals.js';

export type QueuedNodeResult =
    | {
          readonly kind: 'completed';
          readonly node: AbgNodeSpec;
          readonly lastSignal?: AbgSignal;
          readonly lastEventType?: string;
          readonly lastPolicyDecision?: AbgPolicyDecision;
      }
    | {
          readonly kind: 'failed';
          readonly node: AbgNodeSpec;
          readonly attempt: number;
      }
    | {
          readonly kind: 'blocked';
      };

type NodeRunResult = {
    readonly status: 'completed' | 'failed';
    readonly lastSignal?: AbgSignal;
    readonly lastEventType?: string;
    readonly lastPolicyDecision?: AbgPolicyDecision;
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
    state.events.push(...gate.events);
    if (gate.kind === 'blocked') {
        return { kind: 'blocked' };
    }

    const attempt = nextAttempt(state.attemptsByNodeId, node.id);
    state.totalNodeRuns += 1;
    const model = nodeModel(graph, node.id, input.modelProviderSelection);
    state.events.push(attemptEvent('attempt.started', graph.id, node, input, attempt, state.maxAttempts));
    const runResult = gate.approvedHumanApproval
        ? runApprovedHumanApprovalNode(graph, node, input, state, model, attempt)
        : await runAttempt(graph, node, registry, input, state, model, attempt);
    if (runResult.status === 'failed') {
        state.events.push(
            attemptEvent(
                'attempt.failed',
                graph.id,
                node,
                input,
                attempt,
                state.maxAttempts,
                attemptFailureError(node, attempt, state.maxAttempts),
            ),
        );
        return { kind: 'failed', node, attempt };
    }
    state.events.push(attemptEvent('attempt.completed', graph.id, node, input, attempt, state.maxAttempts));
    return {
        kind: 'completed',
        node,
        ...(runResult.lastSignal !== undefined ? { lastSignal: runResult.lastSignal } : {}),
        ...(runResult.lastEventType !== undefined ? { lastEventType: runResult.lastEventType } : {}),
        ...(runResult.lastPolicyDecision !== undefined ? { lastPolicyDecision: runResult.lastPolicyDecision } : {}),
    };
}

async function runAttempt(
    graph: AuthorableAbgGraph,
    node: AbgNodeSpec,
    registry: AbgNodeRegistry,
    input: AbgGraphRunnerInput,
    state: CoordinatorState,
    model: AbgNodeModelOptions,
    attempt: number,
): Promise<NodeRunResult> {
    if (node.kind === 'llm') {
        state.events.push(modelCallEvent('model.call.started', graph.id, node, input, model));
    }
    if (node.kind === 'tool') {
        state.events.push(toolLifecycleEvent('tool.started', graph.id, node, input, `tool started: ${node.id}`));
    }
    const result = await runNode(graph, node, registry, input, state, model, attempt);
    if (node.kind === 'llm') {
        state.events.push(modelCallEvent('model.call.completed', graph.id, node, input, model));
    }
    if (node.kind === 'tool') {
        state.events.push(
            toolLifecycleEvent(
                result.status === 'completed' ? 'tool.completed' : 'tool.failed',
                graph.id,
                node,
                input,
                result.status === 'completed' ? `tool completed: ${node.id}` : `tool failed: ${node.id}`,
            ),
        );
    }
    return result;
}

function runApprovedHumanApprovalNode(
    graph: AuthorableAbgGraph,
    node: AbgNodeSpec,
    input: AbgGraphRunnerInput,
    state: CoordinatorState,
    model: AbgNodeModelOptions,
    attempt: number,
): NodeRunResult {
    const startedSignal = { type: 'started', graphId: graph.id, nodeId: node.id } satisfies AbgSignal;
    const successSignal = {
        type: 'success',
        graphId: graph.id,
        nodeId: node.id,
        result: { approved: true },
    } satisfies AbgSignal;
    const signals: readonly AbgSignal[] = [startedSignal, successSignal];
    for (const signal of signals) {
        state.nodeStatuses[signal.nodeId] = nodeStatusForSignal(signal);
        state.events.push(
            projectAbgSignalToEvent({
                graphId: graph.id,
                sessionId: input.sessionId,
                timestamp: input.now(),
                signal,
                nodeKind: node.kind,
                model,
                attempt,
                maxAttempts: state.maxAttempts,
            }),
        );
    }
    return { status: 'completed', lastSignal: successSignal };
}

async function runNode(
    graph: AuthorableAbgGraph,
    node: AbgNodeSpec,
    registry: AbgNodeRegistry,
    input: AbgGraphRunnerInput,
    state: CoordinatorState,
    model: AbgNodeModelOptions,
    attempt: number,
): Promise<NodeRunResult> {
    let lastSignal: AbgSignal | undefined;
    let failed = false;
    // Per-node runtime edge inputs (NOT shared state — concurrent node runs each carry
    // their own, so rule-gated edges evaluate against the node that just ran, not a
    // sibling's clobbered value).
    let lastEventType: string | undefined;
    let lastPolicyDecision: AbgPolicyDecision | undefined;
    for await (const signal of runAbgNode(registry, node, runContext(graph, registry, input, state))) {
        lastSignal = signal;
        state.nodeStatuses[signal.nodeId] = nodeStatusForSignal(signal);
        failed = failed || signal.type === 'failure';
        if (signal.type === 'emit') {
            lastEventType = signal.event.type;
            const policyDecision = extractPolicyDecision(signal);
            if (policyDecision !== undefined) {
                lastPolicyDecision = policyDecision;
            }
        }
        state.events.push(
            projectAbgSignalToEvent({
                graphId: graph.id,
                sessionId: input.sessionId,
                timestamp: input.now(),
                signal,
                nodeKind: node.kind,
                model: nodeModel(graph, signal.nodeId, input.modelProviderSelection) ?? model,
                attempt,
                maxAttempts: state.maxAttempts,
            }),
        );
    }
    return {
        status: failed ? 'failed' : 'completed',
        ...(lastSignal !== undefined ? { lastSignal } : {}),
        ...(lastEventType !== undefined ? { lastEventType } : {}),
        ...(lastPolicyDecision !== undefined ? { lastPolicyDecision } : {}),
    };
}

/**
 * Pull a policy decision out of a `policy.evaluated` emit signal so rule-gated edges
 * can match on it via `policy.decision.equals`. Validated with the schema (never trusts
 * an arbitrary payload shape).
 */
function extractPolicyDecision(signal: AbgSignal): AbgPolicyDecision | undefined {
    if (signal.type !== 'emit' || signal.event.type !== 'policy.evaluated') {
        return undefined;
    }
    const payload = signal.event.payload;
    if (payload === undefined || payload === null || typeof payload !== 'object' || !('decision' in payload)) {
        return undefined;
    }
    const candidate = (payload as { decision: unknown }).decision;
    const parsed = AbgPolicyDecisionSchema.safeParse(candidate);
    return parsed.success ? parsed.data : undefined;
}

function attemptFailureError(node: AbgNodeSpec, attempt: number, maxAttempts: number): AbgRuntimeError {
    const retryable = attempt < maxAttempts;
    return {
        code: retryable ? 'node_attempt_failed' : 'node_retry_exhausted',
        message: retryable ? `ABG node attempt failed: ${node.id}` : `ABG node retry limit exhausted: ${node.id}`,
        retryable,
    };
}
