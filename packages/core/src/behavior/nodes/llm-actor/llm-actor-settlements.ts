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

/**
 * Normalize AI SDK / flat-bridge / transport errors into the graph failure shape.
 * Critical: AI SDK uses `isRetryable` + `statusCode`, not `retryable` + `code`.
 * Transient overload (ZAI 503 / "temporarily overloaded") must stay retryable so
 * intent-gate can use node maxAttempts instead of dying as non-retryable terminal.
 */
export function classifyProviderStreamError(
    error: unknown,
): { readonly code: string; readonly retryable: boolean } | undefined {
    const chain = errorChain(error);
    let explicitCode: string | undefined;
    let explicitRetryable: boolean | undefined;
    let statusCode: number | undefined;
    let isRetryableFlag: boolean | undefined;
    const messages: string[] = [];

    for (const item of chain) {
        explicitCode ??= codeOfString(item);
        explicitRetryable ??= retryableOf(item);
        statusCode ??= statusCodeOf(item);
        isRetryableFlag ??= isRetryableOf(item);
        const message = messageOf(item);
        if (message !== undefined && message.length > 0) messages.push(message);
    }
    const message = messages.join('\n');

    if (explicitCode === 'provider_aborted' || explicitCode === 'provider_auth_failed') {
        return { code: explicitCode, retryable: false };
    }
    if (explicitCode === 'provider_context_overflow') {
        return { code: explicitCode, retryable: false };
    }

    // Transient overload always wins — even after AI SDK RetryError maxRetriesExceeded /
    // isRetryable:false — so the graph can spend its own maxAttempts budget.
    if (isTransientProviderFailure({ statusCode, message, code: explicitCode })) {
        return { code: 'provider_rate_limited', retryable: true };
    }

    if (explicitCode === 'provider_rate_limited' || explicitCode === 'provider_timeout') {
        return { code: explicitCode, retryable: true };
    }

    if (explicitCode !== undefined) {
        return { code: explicitCode, retryable: explicitRetryable ?? false };
    }

    if (statusCode === 401 || statusCode === 403) {
        return { code: 'provider_auth_failed', retryable: false };
    }
    if (statusCode === 429 || (statusCode !== undefined && statusCode >= 500 && statusCode < 600)) {
        return { code: 'provider_rate_limited', retryable: true };
    }

    if (isRetryableFlag === true) {
        return { code: 'unknown', retryable: true };
    }
    if (isRetryableFlag === false) {
        return { code: 'unknown', retryable: false };
    }
    if (explicitRetryable !== undefined) {
        return { code: 'unknown', retryable: explicitRetryable };
    }
    return undefined;
}

/** Walk AI SDK RetryError.lastError / cause / error nests for classification. */
function errorChain(error: unknown): readonly unknown[] {
    const chain: unknown[] = [];
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current !== undefined && current !== null && !seen.has(current)) {
        seen.add(current);
        chain.push(current);
        if (typeof current !== 'object') break;
        if (hasField(current, 'lastError')) {
            current = current.lastError;
            continue;
        }
        if (hasField(current, 'cause')) {
            current = current.cause;
            continue;
        }
        if (hasField(current, 'error')) {
            current = current.error;
            continue;
        }
        break;
    }
    return chain;
}

function isTransientProviderFailure(input: {
    readonly statusCode: number | undefined;
    readonly message: string;
    readonly code: string | undefined;
}): boolean {
    if (input.statusCode === 429 || input.statusCode === 502 || input.statusCode === 503 || input.statusCode === 504 || input.statusCode === 529) {
        return true;
    }
    if (input.statusCode !== undefined && input.statusCode >= 500 && input.statusCode < 600) {
        return true;
    }
    const code = (input.code ?? '').toLowerCase();
    if (
        code === 'rate_limit_exceeded' ||
        code === 'overloaded_error' ||
        code === 'overloaded' ||
        code === 'server_error' ||
        code === 'provider_rate_limited'
    ) {
        return true;
    }
    const message = input.message.toLowerCase();
    return (
        message.includes('temporarily overloaded') ||
        message.includes('service may be temporarily overloaded') ||
        message.includes('overloaded') ||
        message.includes('rate limit') ||
        message.includes('too many requests') ||
        message.includes('try again later')
    );
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

function isRetryableOf(value: unknown): boolean | undefined {
    if (hasField(value, 'isRetryable')) return typeof value.isRetryable === 'boolean' ? value.isRetryable : undefined;
    return undefined;
}

function statusCodeOf(value: unknown): number | undefined {
    if (hasField(value, 'statusCode') && typeof value.statusCode === 'number') return value.statusCode;
    if (hasField(value, 'status') && typeof value.status === 'number') return value.status;
    return undefined;
}

function messageOf(value: unknown): string | undefined {
    if (hasField(value, 'message') && typeof value.message === 'string') return value.message;
    if (value instanceof Error) return value.message;
    return undefined;
}

function codeOfString(value: unknown): string | undefined {
    if (hasField(value, 'code') && typeof value.code === 'string') return value.code;
    return undefined;
}

function hasField<Field extends string>(value: unknown, field: Field): value is Record<Field, unknown> {
    return typeof value === 'object' && value !== null && field in value;
}
