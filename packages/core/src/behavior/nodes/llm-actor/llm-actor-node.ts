/**
 * LLMActor node (ABG §10.1) — wraps a Vercel AI SDK `streamText` call and exposes it as
 * an `AsyncIterable<AbgSignal>`, the universal ABG node contract.
 *
 * KEYSTONE CONSTRAINT (plan §5.2), made STRUCTURAL: every call hardcodes
 * `stopWhen: stepCountIs(1)`, so the SDK performs exactly ONE model call + ONE tool batch
 * per node execution. There is no override: the Observe→Decide→Act loop is owned by the
 * ABG graph (the coordinator's re-entry / driver loop in Phase 1), NOT by the SDK. With
 * the SDK's default multi-step loop, the SDK — not the graph — would be the decision
 * authority, hollowing out D1 and violating ABG §10.3. (In AI SDK v6, `maxSteps` was
 * removed; `stopWhen: stepCountIs(n)` is the equivalent. Whitelisted subagent loops are
 * a Phase 1 concern, reintroduced deliberately and tested.)
 *
 * Signals emitted:
 *   started, llm.turn.started (emit), … per-part deltas/proposals …,
 *   then EITHER llm.turn.completed (emit) + success   (on a completed turn)
 *   OR      llm.error (emit) + failure                  (on stream error / abort).
 * The node always reaches a terminal signal — it never hangs or rejects unhandled.
 */

import type { AbgSignal } from '@mission-control/protocol';
import type { ModelMessage, ToolSet } from 'ai';
import { stepCountIs, streamText } from 'ai';
import { createObservabilityRedactor, type ObservabilityRedactor } from '../../../providers/observability-redactor';
import { errorToString } from '../../../util/error-to-string';
import { createAbgEmitSignal } from '../../abg-emit';
import type { AbgToolSettlementLedger } from './abg-tool-bridge';
import { abgSignalsFromStreamPart, createStreamPartObservabilityState } from './ai-sdk-adapter';
import {
    approvalBlockFailure,
    extractProviderErrorCode,
    extractProviderErrorRetryable,
    extractProviderRetryExhausted,
    extractToolCallId,
    firstApprovalBlockedSettlementInProposalOrder,
    terminalToolFailure,
} from './llm-actor-settlements';

type StreamTextParameters = Parameters<typeof streamText>[0];

/** The Vercel AI SDK model type accepted by `streamText({ model })`. */
export type LlmActorModel = StreamTextParameters['model'];

/**
 * The result of one `LLMActor` turn (one model call + one tool batch, per
 * `stopWhen: stepCountIs(1)`). `responseMessages` is the assistant turn INCLUDING every
 * tool-result message (the SDK includes executed tool results in `response.messages`),
 * so the graph can append it to the Blackboard and re-enter with the full history —
 * the loop the SDK's own multi-step machinery would otherwise own.
 */
export type LlmActorTurnResult = {
    readonly text: string;
    readonly usage: unknown;
    readonly responseMessages: readonly ModelMessage[];
};

export type LlmActorRunInput = {
    readonly graphId?: string;
    readonly nodeId: string;
    readonly model: LlmActorModel;
    readonly system: string;
    readonly messages: NonNullable<StreamTextParameters['messages']>;
    readonly tools?: ToolSet;
    readonly signal?: AbortSignal;
    readonly now: () => string;
    readonly settlementLedger?: AbgToolSettlementLedger;
    readonly haltOnFailedToolSettlement?: boolean;
    readonly observabilityRedactor?: ObservabilityRedactor;
    readonly captureRawTurnResult?: (result: LlmActorTurnResult) => void;
};

export async function* runLlmActor(input: LlmActorRunInput): AsyncIterable<AbgSignal> {
    const { nodeId, now } = input;
    const observabilityRedactor = input.observabilityRedactor ?? createObservabilityRedactor();
    const adapterContext = {
        graphId: input.graphId,
        nodeId,
        now,
        ...(input.settlementLedger !== undefined ? { settlementLedger: input.settlementLedger } : {}),
        observabilityRedactor,
        observabilityStreams: createStreamPartObservabilityState(),
    };
    const graphIdPart = input.graphId !== undefined ? { graphId: input.graphId } : {};

    yield { type: 'started', nodeId, ...graphIdPart };
    yield createAbgEmitSignal({
        graphId: input.graphId,
        nodeId,
        source: 'llm-actor',
        eventType: 'llm.turn.started',
        timestamp: now(),
    });

    const result = streamText({
        model: input.model,
        system: input.system,
        messages: input.messages,
        stopWhen: stepCountIs(1),
        onError: () => undefined,
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.signal !== undefined ? { abortSignal: input.signal } : {}),
    });

    let turnText = '';
    let turnUsage: unknown;
    let turnResponseMessages: readonly ModelMessage[] = [];
    // Track proposals in stream order so the approval-block check respects proposal order. The
    // SDK dispatches execute in non-deterministic order under a serialized batch; the ledger
    // records in completion order. Using the first-PROPOSED matches flat "first tool call" parity.
    const proposedToolCallIds: string[] = [];
    try {
        for await (const part of result.fullStream) {
            for (const signal of abgSignalsFromStreamPart(part, adapterContext)) {
                if (signal.type === 'emit' && signal.event.type === 'llm.tool_call.proposed') {
                    const proposedId = extractToolCallId(signal.event.payload);
                    if (proposedId !== undefined) {
                        proposedToolCallIds.push(proposedId);
                    }
                }
                yield signal;
            }
        }
        const [text, usage, response] = await Promise.all([result.text, result.usage, result.response]);
        turnText = text;
        turnUsage = usage;
        turnResponseMessages = response.messages;
    } catch (error) {
        // Redact credentials from the surfaced error message (parity with the flat path, which
        // redacts provider error messages at the provider-event layer) so a provider failure
        // carrying a secret does not leak into the `llm.error` emit (rendered + persisted).
        const message = observabilityRedactor.redactText(errorToString(error));
        const errorCode = extractProviderErrorCode(error);
        const retryable = extractProviderErrorRetryable(error);
        const retryExhausted = extractProviderRetryExhausted(error);
        yield createAbgEmitSignal({
            graphId: input.graphId,
            nodeId,
            source: 'llm-actor',
            eventType: 'llm.error',
            timestamp: now(),
            payload: observabilityRedactor.redactValue({
                error: message,
                ...(errorCode !== undefined ? { errorCode } : {}),
            }),
        });
        // Carry the structured provider error code in the failure signal so the graph runner can
        // surface it on the result and the turn-runner mapping can distinguish an abort
        // (`provider_aborted`) from a hard failure the way the flat run coordinator does. The signal
        // field is `error: unknown`, so a structured object is permitted without a protocol change.
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: observabilityRedactor.redactValue(
                errorCode !== undefined
                    ? {
                          message,
                          code: errorCode,
                          providerError: true,
                          ...(retryable !== undefined ? { retryable } : {}),
                          ...(retryExhausted ? { retryExhausted: true } : {}),
                      }
                    : message,
            ),
        };
        return;
    }

    // Approval-block short-circuit: if a tool settled as `approval_required` (a permission gate
    // in `block` mode with no automation), the graph must settle as `blocked` — parity with the
    // flat run coordinator's `approvalBlockedSettlement` detection. Surfacing the block to the
    // model instead would make it retry the same call until the loop budget is exhausted. Emit a
    // `failure` carrying the `tool_approval_blocked` code + toolCallId so the coordinator settles
    // the graph as `blocked` (not retried as a hard failure). The gate already emitted the
    // `approval.requested`/`approval.blocked` events through the registry, so no duplicate emit.
    const approvalBlock = firstApprovalBlockedSettlementInProposalOrder(input.settlementLedger, proposedToolCallIds);
    if (approvalBlock !== undefined) {
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: observabilityRedactor.redactValue(approvalBlockFailure(approvalBlock)),
        };
        return;
    }

    // A tool that settled `approval_denied` (the user denied the permission gate) is intentionally
    // NOT short-circuited. The bridge surfaces the denial to the model as a readable tool-result
    // string, so the re-entry loop feeds it back and the model can adapt. A single read-only-tool
    // denial must not terminate a long multi-step run. Retry is bounded by `maxNodeRuns`.

    // Terminal tool-failure short-circuit: when `haltOnFailedToolSettlement` is set, a tool that
    // settled `failed` for a NON-approval reason (e.g. `command_not_allowed` — a non-allowlisted
    // command the model cannot fix by retrying) terminates the run — parity with the flat run
    // coordinator's `haltOnFailedToolSettlement` / `terminalFailedSettlement`. Surfacing an
    // unfixable error would otherwise make the model retry the same call until the node-run budget
    // is exhausted. Emit a `failure` carrying `tool_settlement_failed` + toolCallId so the node
    // runner marks it terminal (no retry) and the coordinator fails the run immediately.
    if (input.haltOnFailedToolSettlement === true) {
        const terminalFailure = input.settlementLedger?.terminalFailedSettlement();
        if (terminalFailure !== undefined) {
            yield {
                type: 'failure',
                nodeId,
                ...graphIdPart,
                error: observabilityRedactor.redactValue(terminalToolFailure(terminalFailure)),
            };
            return;
        }
    }

    yield createAbgEmitSignal({
        graphId: input.graphId,
        nodeId,
        source: 'llm-actor',
        eventType: 'llm.turn.completed',
        timestamp: now(),
        payload: observabilityRedactor.redactValue({ text: turnText, usage: turnUsage }),
    });
    const rawTurnResult: LlmActorTurnResult = {
        text: turnText,
        usage: turnUsage,
        responseMessages: turnResponseMessages,
    };
    input.captureRawTurnResult?.(rawTurnResult);
    yield {
        type: 'success',
        nodeId,
        ...graphIdPart,
        result: observabilityRedactor.redactValue(rawTurnResult),
    };
}
