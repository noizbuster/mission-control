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
import { errorToString } from '../../../util/error-to-string.js';
import { createAbgEmitSignal } from '../../abg-emit.js';
import type { AbgToolSettlement, AbgToolSettlementLedger } from './abg-tool-bridge.js';
import { abgSignalsFromStreamPart } from './ai-sdk-adapter.js';

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
};

export async function* runLlmActor(input: LlmActorRunInput): AsyncIterable<AbgSignal> {
    const { nodeId, now } = input;
    const adapterContext = {
        graphId: input.graphId,
        nodeId,
        now,
        ...(input.settlementLedger !== undefined ? { settlementLedger: input.settlementLedger } : {}),
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
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
        ...(input.signal !== undefined ? { abortSignal: input.signal } : {}),
    });

    let turnText = '';
    let turnUsage: unknown;
    let turnResponseMessages: readonly ModelMessage[] = [];
    try {
        for await (const part of result.fullStream) {
            for (const signal of abgSignalsFromStreamPart(part, adapterContext)) {
                yield signal;
            }
        }
        const [text, usage, response] = await Promise.all([result.text, result.usage, result.response]);
        turnText = text;
        turnUsage = usage;
        turnResponseMessages = response.messages;
    } catch (error) {
        const message = errorToString(error);
        const errorCode = extractProviderErrorCode(error);
        yield createAbgEmitSignal({
            graphId: input.graphId,
            nodeId,
            source: 'llm-actor',
            eventType: 'llm.error',
            timestamp: now(),
            payload: { error: message, ...(errorCode !== undefined ? { errorCode } : {}) },
        });
        // Carry the structured provider error code in the failure signal so the graph runner can
        // surface it on the result and the turn-runner mapping can distinguish an abort
        // (`provider_aborted`) from a hard failure the way the flat run coordinator does. The signal
        // field is `error: unknown`, so a structured object is permitted without a protocol change.
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: errorCode !== undefined ? { message, code: errorCode } : message,
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
    const approvalBlock = input.settlementLedger?.approvalBlockedSettlement();
    if (approvalBlock !== undefined) {
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: approvalBlockFailure(approvalBlock),
        };
        return;
    }

    // Approval-denied short-circuit: if a tool settled as `approval_denied` (the permission gate
    // denied it), the run is a terminal failure — parity with the flat run coordinator's
    // `terminalFailedSettlement`. Surfacing the denial to the model would make it retry the denied
    // call until the loop budget is exhausted. Emit a `failure` carrying `tool_denied` + toolCallId
    // so the coordinator fails the run (non-retryable) with the toolCallId.
    const denied = input.settlementLedger?.deniedSettlement();
    if (denied !== undefined) {
        yield {
            type: 'failure',
            nodeId,
            ...graphIdPart,
            error: approvalDeniedFailure(denied),
        };
        return;
    }

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
                error: terminalToolFailure(terminalFailure),
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
        payload: { text: turnText, usage: turnUsage },
    });
    const turnResult: LlmActorTurnResult = {
        text: turnText,
        usage: turnUsage,
        responseMessages: turnResponseMessages,
    };
    yield { type: 'success', nodeId, ...graphIdPart, result: turnResult };
}

/**
 * Extract a provider error code from a thrown error so the graph can preserve the abort/fail
 * distinction. Flat-bridge and provider-turn errors carry a `ProtocolError` under a nested `.error`
 * field; some carry `.code` directly. Uses `in`/`typeof` narrowing (no casts) so the helper stays
 * cast-free. Returns `undefined` for errors with no recognizable code (the common case).
 */
function extractProviderErrorCode(error: unknown): string | undefined {
    if (hasField(error, 'error')) {
        const nested = codeOfString(error.error);
        if (nested !== undefined) {
            return nested;
        }
    }
    return codeOfString(error);
}

function codeOfString(value: unknown): string | undefined {
    if (typeof value === 'object' && value !== null && hasField(value, 'code') && typeof value.code === 'string') {
        return value.code;
    }
    return undefined;
}

function hasField<T extends string>(value: unknown, field: T): value is Record<T, unknown> {
    return typeof value === 'object' && value !== null && field in value;
}

/**
 * Shape the LLMActor puts in a `failure` signal when a tool settled as `approval_required`, so the
 * coordinator can settle the graph as `blocked` (resumable) and the turn-runner mapping can thread
 * the `toolCallId` into the `blocked_on_approval` result — parity with the flat run coordinator's
 * approval-block detection. `code: 'tool_approval_blocked'` is the discriminator the node runner
 * recognizes; the rest carries the block context.
 */
function approvalBlockFailure(settlement: AbgToolSettlement): {
    readonly code: 'tool_approval_blocked';
    readonly toolCallId: string;
    readonly toolName: string;
    readonly approvalCode: string;
    readonly message: string;
} {
    return {
        code: 'tool_approval_blocked',
        toolCallId: settlement.toolCallId,
        toolName: settlement.toolName,
        approvalCode: 'approval_required',
        message: settlement.error?.message ?? 'tool blocked pending approval',
    };
}

/**
 * Shape the LLMActor puts in a `failure` signal when a tool settled as `approval_denied`, so the
 * coordinator fails the run (non-retryable) with the toolCallId — parity with the flat run
 * coordinator's `terminalFailedSettlement` for a denied tool. `code: 'tool_denied'` is the
 * discriminator the node runner recognizes as terminal (no retry).
 */
function approvalDeniedFailure(settlement: AbgToolSettlement): {
    readonly code: 'tool_denied';
    readonly toolCallId: string;
    readonly toolName: string;
    readonly message: string;
} {
    return {
        code: 'tool_denied',
        toolCallId: settlement.toolCallId,
        toolName: settlement.toolName,
        message: settlement.error?.message ?? 'tool denied',
    };
}

/**
 * Shape the LLMActor puts in a `failure` signal when a tool settled `failed` for a non-approval
 * reason (under `haltOnFailedToolSettlement`), so the coordinator fails the run immediately (no
 * retry) with the toolCallId — parity with the flat run coordinator's `terminalFailedSettlement`
 * for a non-approval tool failure. `code: 'tool_settlement_failed'` is the discriminator the node
 * runner recognizes as terminal (no retry); `retryable: false` mirrors the flat result's errorCode.
 */
function terminalToolFailure(settlement: AbgToolSettlement): {
    readonly code: 'tool_settlement_failed';
    readonly retryable: false;
    readonly toolCallId: string;
    readonly toolName: string;
    readonly message: string;
} {
    return {
        code: 'tool_settlement_failed',
        retryable: false,
        toolCallId: settlement.toolCallId,
        toolName: settlement.toolName,
        message: settlement.error?.message ?? 'tool failed',
    };
}
