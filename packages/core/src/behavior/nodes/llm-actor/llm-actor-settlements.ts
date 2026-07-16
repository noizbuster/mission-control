import { classifyProviderStreamError } from '../../failure-taxonomy';
import {
    type AbgToolSettlement,
    type AbgToolSettlementLedger,
    isApprovalRequiredSettlement,
} from './abg-tool-bridge';

export { classifyProviderStreamError };

export function firstApprovalBlockedSettlementInProposalOrder(
    ledger: AbgToolSettlementLedger | undefined,
    proposedToolCallIds: readonly string[],
): AbgToolSettlement | undefined {
    if (ledger === undefined) return undefined;
    for (const toolCallId of proposedToolCallIds) {
        const settlement = ledger.lookup(toolCallId);
        if (settlement !== undefined && isApprovalRequiredSettlement(settlement)) return settlement;
    }
    return ledger.approvalBlockedSettlement();
}

export function extractToolCallId(payload: unknown): string | undefined {
    if (!hasField(payload, 'toolCallId')) return undefined;
    return typeof payload.toolCallId === 'string' ? payload.toolCallId : undefined;
}

export function extractProposedToolName(payload: unknown): string | undefined {
    if (!hasField(payload, 'toolName')) return undefined;
    return typeof payload.toolName === 'string' ? payload.toolName : undefined;
}

export function extractProviderErrorCode(error: unknown): string | undefined {
    return classifyProviderStreamError(error)?.code;
}

export function extractProviderErrorRetryable(error: unknown): boolean | undefined {
    return classifyProviderStreamError(error)?.retryable;
}

export function extractProviderRetryExhausted(error: unknown): boolean {
    if (hasField(error, 'retryExhausted') && error.retryExhausted === true) return true;
    if (hasField(error, 'error')) {
        const nested = error.error;
        if (hasField(nested, 'retryExhausted') && nested.retryExhausted === true) return true;
    }
    return false;
}

export function approvalBlockFailure(settlement: AbgToolSettlement): {
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

export function terminalToolFailure(settlement: AbgToolSettlement): {
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

function hasField<Field extends string>(value: unknown, field: Field): value is Record<Field, unknown> {
    return typeof value === 'object' && value !== null && field in value;
}
