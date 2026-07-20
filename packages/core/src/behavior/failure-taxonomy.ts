/**
 * Pure ABG Progress Contract failure taxonomy (ABG §13.4 / §13.6).
 *
 * Maps provider/transport/structured/routing errors into
 * `{ class, code, retryable, retryDisposition? }` with classes
 * `transient | rejected | denied | terminal`. Alias inputs (e.g.
 * `structured_output_invalid`) emit only the canonical code.
 *
 * Callers combine class + node attempt budget: provider `retryExhausted` must
 * not terminal-kill when `isBudgetScopedRetryable` is true and budget remains.
 */

import {
    hasClassifiableSignal,
    inspectFailureSignals,
    isNetworkProviderFailure,
    isTransientProviderFailure,
    isUsageExhaustionFailure,
} from './failure-taxonomy-inspect';

export const FAILURE_CLASSES = ['transient', 'rejected', 'denied', 'terminal'] as const;
export type FailureClass = (typeof FAILURE_CLASSES)[number];

export const RETRY_DISPOSITIONS = ['never', 'after_delay', 'after_change', 'after_reconcile'] as const;
export type RetryDisposition = (typeof RETRY_DISPOSITIONS)[number];

export type FailureClassification = {
    readonly class: FailureClass;
    readonly code: string;
    readonly retryable: boolean;
    readonly retryDisposition?: RetryDisposition;
};

export const CANONICAL_FAILURE_CODES = {
    INVALID_STRUCTURED_OUTPUT: 'invalid_structured_output',
    ROUTING_DEAD_END: 'routing_dead_end',
    PROVIDER_TIMEOUT: 'provider_timeout',
    PROVIDER_RATE_LIMITED: 'provider_rate_limited',
    PROVIDER_USAGE_EXHAUSTED: 'provider_usage_exhausted',
    PROVIDER_AUTH_FAILED: 'provider_auth_failed',
    PROVIDER_ABORTED: 'provider_aborted',
    PROVIDER_CONTEXT_OVERFLOW: 'provider_context_overflow',
    TOOL_APPROVAL_BLOCKED: 'tool_approval_blocked',
    TOOL_SETTLEMENT_FAILED: 'tool_settlement_failed',
    TASK_YIELD_MISSING: 'task_yield_missing',
    TASK_CHILD_FAILED: 'task_child_failed',
    UNKNOWN: 'unknown',
} as const;

const CODE_ALIASES: Readonly<Record<string, string>> = {
    structured_output_invalid: CANONICAL_FAILURE_CODES.INVALID_STRUCTURED_OUTPUT,
};

export function classifyFailure(input: unknown): FailureClassification {
    const signals = inspectFailureSignals(input);
    const {
        explicitCode,
        explicitRetryable,
        statusCode,
        isRetryableFlag,
        message,
        joinedCodes,
    } = signals;
    const normalizedCode = normalizeCode(explicitCode);

    const byCode = classifyKnownCode(normalizedCode);
    if (byCode !== undefined) return byCode;

    if (isUsageExhaustionFailure({ statusCode, message, code: explicitCode ?? joinedCodes })) {
        return transient(CANONICAL_FAILURE_CODES.PROVIDER_USAGE_EXHAUSTED);
    }

    if (isTransientProviderFailure({ statusCode, message, code: explicitCode ?? joinedCodes })) {
        return transient(CANONICAL_FAILURE_CODES.PROVIDER_RATE_LIMITED);
    }

    if (isNetworkProviderFailure({ message, code: explicitCode ?? joinedCodes })) {
        return transient(CANONICAL_FAILURE_CODES.PROVIDER_TIMEOUT);
    }

    if (
        normalizedCode === CANONICAL_FAILURE_CODES.PROVIDER_RATE_LIMITED ||
        normalizedCode === CANONICAL_FAILURE_CODES.PROVIDER_USAGE_EXHAUSTED ||
        normalizedCode === CANONICAL_FAILURE_CODES.PROVIDER_TIMEOUT
    ) {
        return transient(normalizedCode);
    }

    if (statusCode === 401 || statusCode === 403) {
        return terminal(CANONICAL_FAILURE_CODES.PROVIDER_AUTH_FAILED);
    }
    if (statusCode === 429 || (statusCode !== undefined && statusCode >= 500 && statusCode < 600)) {
        return transient(CANONICAL_FAILURE_CODES.PROVIDER_RATE_LIMITED);
    }

    if (normalizedCode !== undefined) {
        if (explicitRetryable === true || isRetryableFlag === true) {
            return { class: 'transient', code: normalizedCode, retryable: true, retryDisposition: 'after_delay' };
        }
        return {
            class: 'terminal',
            code: normalizedCode,
            retryable: explicitRetryable ?? false,
            retryDisposition: 'never',
        };
    }

    if (isRetryableFlag === true || explicitRetryable === true) {
        return transient(CANONICAL_FAILURE_CODES.UNKNOWN);
    }
    return terminal(CANONICAL_FAILURE_CODES.UNKNOWN);
}

export function classifyProviderStreamError(
    error: unknown,
): { readonly code: string; readonly retryable: boolean } | undefined {
    if (!hasClassifiableSignal(error)) return undefined;
    const classified = classifyFailure(error);
    return { code: classified.code, retryable: classified.retryable };
}

export function isBudgetScopedRetryable(classification: FailureClassification): boolean {
    return classification.class === 'transient' || classification.class === 'rejected';
}

function classifyKnownCode(code: string | undefined): FailureClassification | undefined {
    if (code === undefined) return undefined;

    switch (code) {
        case CANONICAL_FAILURE_CODES.PROVIDER_ABORTED:
        case CANONICAL_FAILURE_CODES.PROVIDER_AUTH_FAILED:
        case CANONICAL_FAILURE_CODES.PROVIDER_CONTEXT_OVERFLOW:
            return terminal(code);
        case CANONICAL_FAILURE_CODES.INVALID_STRUCTURED_OUTPUT:
            return rejected(code, 'after_change');
        case CANONICAL_FAILURE_CODES.ROUTING_DEAD_END:
            return rejected(code, 'after_change');
        case CANONICAL_FAILURE_CODES.TOOL_APPROVAL_BLOCKED:
            return denied(code);
        case CANONICAL_FAILURE_CODES.TASK_YIELD_MISSING:
            return rejected(code, 'after_change');
        case CANONICAL_FAILURE_CODES.TASK_CHILD_FAILED:
            return terminal(code);
        case CANONICAL_FAILURE_CODES.TOOL_SETTLEMENT_FAILED:
            return terminal(code);
        default:
            return undefined;
    }
}

function normalizeCode(code: string | undefined): string | undefined {
    if (code === undefined) return undefined;
    return CODE_ALIASES[code] ?? code;
}

function transient(code: string): FailureClassification {
    return { class: 'transient', code, retryable: true, retryDisposition: 'after_delay' };
}

function rejected(code: string, disposition: RetryDisposition): FailureClassification {
    return { class: 'rejected', code, retryable: true, retryDisposition: disposition };
}

function denied(code: string): FailureClassification {
    return { class: 'denied', code, retryable: false, retryDisposition: 'never' };
}

function terminal(code: string): FailureClassification {
    return { class: 'terminal', code, retryable: false, retryDisposition: 'never' };
}
