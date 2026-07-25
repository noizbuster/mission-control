import type { AbgNodeModelOptions, AbgNodeSpec, AbgPolicyDecision, AbgSignal } from '@mission-control/protocol';
import { redactAbgSignalForObservability } from '../providers/observability-redactor';
import type { AuthorableAbgGraph } from './authorable-graph';
import { type CoordinatorState, nodeModel, nodeStatusForSignal } from './graph-coordinator-helpers';
import { runContext } from './graph-coordinator-run-context';
import {
    extractPolicyDecision,
    extractTurnText,
    isRetryableToolFailurePayload,
    isTerminalProviderError,
    isTerminalToolFailureError,
    isToolApprovalBlockedError,
    rememberProposedInput,
    toolActionFromEmitWithProposedInput,
} from './graph-coordinator-node-signals';
import type { AbgGraphRunnerInput } from './graph-runner';
import { modelCallEvent, toolLifecycleEvent } from './graph-runner-events';
import type { ToolActionFingerprint } from './loop-safety';
import { type AbgNodeRegistry, runAbgNode } from './node-registry';
import { readBooleanConfig, readStringConfig } from './nodes/composite-node-utils';
import { isEphemeralStreamingAbgSignal, projectAbgSignalToEvent } from './signals';
import { randomUUID } from 'node:crypto';

export type NodeRunResult = {
    readonly status: 'completed' | 'failed' | 'blocked';
    readonly lastSignal?: AbgSignal;
    readonly lastEventType?: string;
    readonly lastPolicyDecision?: AbgPolicyDecision;
    readonly finalText?: string;
    readonly terminal?: boolean;
    readonly hadOnlyRetryableToolFailures?: boolean;
    readonly hadProductiveToolUse?: boolean;
    readonly toolActions: readonly ToolActionFingerprint[];
};

export async function runNodeAttempt(
    graph: AuthorableAbgGraph,
    node: AbgNodeSpec,
    registry: AbgNodeRegistry,
    input: AbgGraphRunnerInput,
    state: CoordinatorState,
    model: AbgNodeModelOptions,
    attempt: number,
): Promise<NodeRunResult> {
    if (node.kind === 'llm') state.events.push(modelCallEvent('model.call.started', graph.id, node, input, model));
    const result = await runNode(graph, node, registry, input, state, model, attempt);
    if (node.kind === 'llm') {
        state.events.push(modelCallEvent('model.call.completed', graph.id, node, input, model, result.finalText));
    }
    return result;
}

export function runApprovedHumanApprovalNode(
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
    for (const signal of [startedSignal, successSignal] satisfies readonly AbgSignal[]) {
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
                observabilityRedactor: state.observabilityRedactor,
            }),
        );
    }
    return { status: 'completed', lastSignal: successSignal, toolActions: [] };
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
    let lastEventType: string | undefined;
    let lastPolicyDecision: AbgPolicyDecision | undefined;
    let finalText: string | undefined;
    let terminal = false;
    let retryableToolFailures = 0;
    let completedTools = 0;
    const toolActions: ToolActionFingerprint[] = [];
    const proposedInputByCallId = new Map<string, string>();
    const toolCallId = node.kind === 'tool' ? (input.createToolCallId ?? randomUUID)() : undefined;
    const context = runContext(graph, registry, input, state, {
        nodeId: node.id,
        ...(toolCallId !== undefined ? { toolCallId } : {}),
    });
    if (toolCallId !== undefined) {
        state.events.push(
            toolLifecycleEvent('tool.started', graph.id, node, input, `tool started: ${node.id}`, toolCallId),
        );
    }
    for await (const rawSignal of runAbgNode(registry, node, context)) {
        const observableSignal = redactAbgSignalForObservability(rawSignal, state.observabilityRedactor);
        await input.onSignal?.(observableSignal);
        const signal = rawSignal;
        lastSignal = signal;
        state.nodeStatuses[signal.nodeId] = nodeStatusForSignal(signal);
        if (signal.type === 'failure' && !isPermittedFanOutChildFailure(node, signal.nodeId)) {
            if (isToolApprovalBlockedError(signal.error)) blocked = true;
            else {
                failed = true;
                if (isTerminalToolFailureError(signal.error) || isTerminalProviderError(signal.error)) terminal = true;
            }
        }
        if (signal.type === 'emit') {
            lastEventType = signal.event.type;
            const policyDecision = extractPolicyDecision(rawSignal);
            if (policyDecision !== undefined) lastPolicyDecision = policyDecision;
            const turnText = extractTurnText(signal);
            if (turnText !== undefined) finalText = turnText;
            if (signal.event.type === 'tool.completed') completedTools += 1;
            if (signal.event.type === 'tool.failed' && isRetryableToolFailurePayload(signal.event.payload)) {
                retryableToolFailures += 1;
            }
            if (rawSignal.type === 'emit') {
                rememberProposedInput(rawSignal.event.type, rawSignal.event.payload, proposedInputByCallId);
                const action = toolActionFromEmitWithProposedInput(
                    rawSignal.event.type,
                    rawSignal.event.payload,
                    proposedInputByCallId,
                );
                if (action !== undefined) toolActions.push(action);
            }
        }
        // Token deltas stay live-only via onSignal above; never bloat the durable ledger.
        if (isEphemeralStreamingAbgSignal(signal)) {
            continue;
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
                observabilityRedactor: state.observabilityRedactor,
            }),
        );
    }
    const hadOnlyRetryableToolFailures = !failed && !blocked && retryableToolFailures > 0 && completedTools === 0;
    const hadProductiveToolUse = completedTools > 0;
    const status = blocked ? 'blocked' : failed ? 'failed' : 'completed';
    if (toolCallId !== undefined) {
        state.events.push(
            toolLifecycleEvent(
                status === 'completed' ? 'tool.completed' : 'tool.failed',
                graph.id,
                node,
                input,
                status === 'completed' ? `tool completed: ${node.id}` : `tool failed: ${node.id}`,
                toolCallId,
            ),
        );
    }
    return {
        status,
        toolActions,
        ...(lastSignal !== undefined ? { lastSignal } : {}),
        ...(lastEventType !== undefined ? { lastEventType } : {}),
        ...(lastPolicyDecision !== undefined ? { lastPolicyDecision } : {}),
        ...(finalText !== undefined ? { finalText } : {}),
        ...(terminal ? { terminal: true } : {}),
        ...(hadOnlyRetryableToolFailures ? { hadOnlyRetryableToolFailures: true } : {}),
        ...(hadProductiveToolUse ? { hadProductiveToolUse: true } : {}),
    };
}

function isPermittedFanOutChildFailure(node: AbgNodeSpec, failureNodeId: string): boolean {
    return (
        node.kind === 'parallel' &&
        failureNodeId !== node.id &&
        readStringConfig(node, 'fanOutKey') !== undefined &&
        readBooleanConfig(node, 'continueOnFailure') === true
    );
}
