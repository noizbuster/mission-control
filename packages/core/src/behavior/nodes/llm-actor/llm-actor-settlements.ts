import {
    type AbgToolSettlement,
    type AbgToolSettlementLedger,
    isApprovalRequiredSettlement,
} from './abg-tool-bridge';

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

export function extractProviderErrorCode(error: unknown): string | undefined {
    if (hasField(error, 'error')) {
        const nested = codeOfString(error.error);
        if (nested !== undefined) return nested;
    }
    return codeOfString(error);
}

export function extractProviderErrorRetryable(error: unknown): boolean | undefined {
    if (hasField(error, 'error')) {
        const nested = retryableOf(error.error);
        if (nested !== undefined) return nested;
    }
    return retryableOf(error);
}

export function extractProviderRetryExhausted(error: unknown): boolean {
    return hasField(error, 'retryExhausted') && error.retryExhausted === true;
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

function retryableOf(value: unknown): boolean | undefined {
    if (hasField(value, 'retryable')) return typeof value.retryable === 'boolean' ? value.retryable : undefined;
    return undefined;
}

function codeOfString(value: unknown): string | undefined {
    if (hasField(value, 'code') && typeof value.code === 'string') return value.code;
    return undefined;
}

function hasField<Field extends string>(value: unknown, field: Field): value is Record<Field, unknown> {
    return typeof value === 'object' && value !== null && field in value;
}
