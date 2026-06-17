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
          readonly lastSignal?: AbgSignal;
          readonly terminal?: boolean;
      }
    | {
          readonly kind: 'blocked';
          readonly lastSignal?: AbgSignal;
      };

type NodeRunResult = {
    readonly status: 'completed' | 'failed' | 'blocked';
    readonly lastSignal?: AbgSignal;
    readonly lastEventType?: string;
    readonly lastPolicyDecision?: AbgPolicyDecision;
    /**
     * The model's final assistant text for an LLM turn (from the `llm.turn.completed` emit), so
     * `model.call.completed` can carry the model's actual output as its message — parity with the
     * flat run loop. Omitted for non-LLM nodes and turns with no text.
     */
    readonly finalText?: string;
    /**
     * A non-retryable failure: the LLMActor short-circuited on a terminal tool settlement (a
     * `command_not_allowed`, or a denial) under `haltOnFailedToolSettlement` / the denied path.
     * Retrying would re-run the model with unchanged input and fail identically, so the coordinator
     * fails the run immediately instead of consuming the retry budget.
     */
    readonly terminal?: boolean;
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
        return {
            kind: 'failed',
            node,
            attempt,
            ...(runResult.lastSignal !== undefined ? { lastSignal: runResult.lastSignal } : {}),
            ...(runResult.terminal === true ? { terminal: true } : {}),
        };
    }
    if (runResult.status === 'blocked') {
        // An approval-block short-circuit (a tool settled `approval_required`): settle the node as
        // blocked — no attempt.completed/attempt.failed, no retry. The terminal failure signal
        // carries the toolCallId/approval context so the coordinator can surface it on the graph
        // result and the turn-runner mapping can thread it into `blocked_on_approval`.
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
        // Carry the turn's final assistant text as the message so consumers (e.g. the session
        // owner's final-message capture) see the model's actual output, matching the flat loop.
        state.events.push(
            modelCallEvent('model.call.completed', graph.id, node, input, model, result.finalText),
        );
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
    let blocked = false;
    // Per-node runtime edge inputs (NOT shared state — concurrent node runs each carry
    // their own, so rule-gated edges evaluate against the node that just ran, not a
    // sibling's clobbered value).
    let lastEventType: string | undefined;
    let lastPolicyDecision: AbgPolicyDecision | undefined;
    let finalText: string | undefined;
    let terminal = false;
    for await (const signal of runAbgNode(registry, node, runContext(graph, registry, input, state))) {
        lastSignal = signal;
        state.nodeStatuses[signal.nodeId] = nodeStatusForSignal(signal);
        if (signal.type === 'failure') {
            // An LLMActor approval-block short-circuit (code `tool_approval_blocked`) settles the
            // node as `blocked`, not `failed` — it must not trigger retry/fail handling.
            if (isToolApprovalBlockedError(signal.error)) {
                blocked = true;
            } else {
                failed = true;
                // A terminal tool-settlement failure (a `command_not_allowed`, or a denial) is
                // non-retryable: the LLMActor short-circuited under `haltOnFailedToolSettlement`
                // because retrying cannot change the outcome. Mark it so the coordinator fails the
                // run immediately instead of consuming the retry budget.
                if (isTerminalToolFailureError(signal.error)) {
                    terminal = true;
                }
            }
        }
        if (signal.type === 'emit') {
            lastEventType = signal.event.type;
            const policyDecision = extractPolicyDecision(signal);
            if (policyDecision !== undefined) {
                lastPolicyDecision = policyDecision;
            }
            const turnText = extractTurnText(signal);
            if (turnText !== undefined) {
                finalText = turnText;
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
        status: blocked ? 'blocked' : failed ? 'failed' : 'completed',
        ...(lastSignal !== undefined ? { lastSignal } : {}),
        ...(lastEventType !== undefined ? { lastEventType } : {}),
        ...(lastPolicyDecision !== undefined ? { lastPolicyDecision } : {}),
        ...(finalText !== undefined ? { finalText } : {}),
        ...(terminal ? { terminal: true } : {}),
    };
}

/**
 * Pull the model's final assistant text off an `llm.turn.completed` emit so `model.call.completed`
 * can carry the model's actual output as its message (parity with the flat run loop). The payload
 * is `unknown`; narrowed with `in`/`typeof` — no cast. Returns `undefined` for other emits.
 */
function extractTurnText(signal: AbgSignal): string | undefined {
    if (signal.type !== 'emit' || signal.event.type !== 'llm.turn.completed') {
        return undefined;
    }
    const payload = signal.event.payload;
    if (typeof payload !== 'object' || payload === null || !('text' in payload)) {
        return undefined;
    }
    const text = payload.text;
    return typeof text === 'string' ? text : undefined;
}

/**
 * Recognize the LLMActor's approval-block failure (a tool settled `approval_required`) so the
 * node settles as `blocked` rather than `failed`. The `error` is `unknown` (the failure signal
 * contract), narrowed with `in`/typeof — no cast.
 */
function isToolApprovalBlockedError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return false;
    }
    return error.code === 'tool_approval_blocked';
}

/**
 * Recognize a terminal tool-settlement failure the LLMActor short-circuited on (a
 * `command_not_allowed` under `haltOnFailedToolSettlement`, or a denial) so the node settles as a
 * NON-retryable `failed`. The `error` is `unknown` (the failure signal contract); narrowed with
 * `in`/typeof — no cast. Matches the codes `terminalToolFailure`/`approvalDeniedFailure` emit.
 */
function isTerminalToolFailureError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('code' in error)) {
        return false;
    }
    return error.code === 'tool_settlement_failed' || error.code === 'tool_denied';
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
