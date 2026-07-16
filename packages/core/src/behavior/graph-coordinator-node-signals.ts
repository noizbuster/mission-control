import {
    type AbgNodeSpec,
    type AbgPolicyDecision,
    AbgPolicyDecisionSchema,
    type AbgRuntimeError,
    type AbgSignal,
} from '@mission-control/protocol';
import { classifyFailure, isBudgetScopedRetryable } from './failure-taxonomy';
import { type ToolActionFingerprint, toolActionFromEmit } from './loop-safety';

export function rememberProposedInput(
    eventType: string,
    payload: unknown,
    proposedInputByCallId: Map<string, string>,
): void {
    if (eventType !== 'llm.tool_call.proposed' || typeof payload !== 'object' || payload === null) return;
    const record = payload as Record<string, unknown>;
    const { toolCallId: candidateToolCallId } = record;
    const toolCallId = typeof candidateToolCallId === 'string' ? candidateToolCallId : undefined;
    if (toolCallId === undefined) return;
    const action = toolActionFromEmit(eventType, payload);
    if (action !== undefined) proposedInputByCallId.set(toolCallId, action.inputDigest);
}

export function toolActionFromEmitWithProposedInput(
    eventType: string,
    payload: unknown,
    proposedInputByCallId: Map<string, string>,
): ToolActionFingerprint | undefined {
    const action = toolActionFromEmit(eventType, payload);
    if (action === undefined) return undefined;
    if (action.inputDigest.length > 0 || typeof payload !== 'object' || payload === null) return action;
    const { toolCallId } = payload as Record<string, unknown>;
    if (typeof toolCallId !== 'string') return action;
    const digest = proposedInputByCallId.get(toolCallId);
    return digest === undefined ? action : { ...action, inputDigest: digest };
}

export function extractTurnText(signal: AbgSignal): string | undefined {
    if (signal.type !== 'emit' || signal.event.type !== 'llm.turn.completed') return undefined;
    const payload = signal.event.payload;
    if (typeof payload !== 'object' || payload === null || !('text' in payload)) return undefined;
    return typeof payload.text === 'string' ? payload.text : undefined;
}

export function isToolApprovalBlockedError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'tool_approval_blocked';
}

export function isTerminalToolFailureError(error: unknown): boolean {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'tool_settlement_failed';
}

export function isTerminalProviderError(error: unknown): boolean {
    if (typeof error !== 'object' || error === null || !('providerError' in error) || error.providerError !== true) {
        return false;
    }
    // Taxonomy owns class: transient/rejected spend the node attempt budget even when the
    // provider layer set retryExhausted (ABG §13.6). Auth/abort/context_overflow stay terminal.
    const classified = classifyFailure(error);
    if (isBudgetScopedRetryable(classified)) {
        return false;
    }
    if (classified.class === 'terminal' || classified.class === 'denied') {
        return true;
    }
    const retryExhausted = 'retryExhausted' in error && error.retryExhausted === true;
    const explicitlyNonRetryable = 'retryable' in error && error.retryable === false;
    return retryExhausted || explicitlyNonRetryable;
}

export function extractPolicyDecision(signal: AbgSignal): AbgPolicyDecision | undefined {
    if (signal.type !== 'emit' || signal.event.type !== 'policy.evaluated') return undefined;
    const payload = signal.event.payload;
    if (payload === undefined || payload === null || typeof payload !== 'object' || !('decision' in payload)) {
        return undefined;
    }
    const parsed = AbgPolicyDecisionSchema.safeParse(payload.decision);
    return parsed.success ? parsed.data : undefined;
}

export function failureCodeFromSignal(signal: AbgSignal | undefined): string | undefined {
    if (signal === undefined || signal.type !== 'failure') {
        return undefined;
    }
    const error = signal.error;
    if (typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string') {
        return error.code;
    }
    return undefined;
}

export function failureMessageFromSignal(signal: AbgSignal | undefined): string | undefined {
    if (signal === undefined || signal.type !== 'failure') {
        return undefined;
    }
    const error = signal.error;
    if (typeof error === 'object' && error !== null && 'message' in error && typeof error.message === 'string') {
        return error.message;
    }
    if (typeof error === 'string' && error.length > 0) {
        return error;
    }
    return undefined;
}

export function attemptFailureError(
    node: AbgNodeSpec,
    attempt: number,
    maxAttempts: number,
    terminal: boolean,
): AbgRuntimeError {
    const retryable = !terminal && attempt < maxAttempts;
    return {
        code: retryable ? 'node_attempt_failed' : 'node_retry_exhausted',
        message: retryable ? `ABG node attempt failed: ${node.id}` : `ABG node retry limit exhausted: ${node.id}`,
        retryable,
    };
}

export function isRetryableToolFailurePayload(payload: unknown): boolean {
    if (typeof payload !== 'object' || payload === null || !('error' in payload)) return false;
    const error = payload.error;
    return typeof error === 'object' && error !== null && 'retryable' in error && error.retryable === true;
}
