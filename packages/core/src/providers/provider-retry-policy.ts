/**
 * Shared provider retry policy for rate-limit / usage-exhaustion waits.
 *
 * Rate limits and quota exhaustion wait indefinitely with exponential backoff,
 * capped at ~30 minutes between attempts. Other retryable errors keep a finite
 * attempt budget. Abort always wins.
 */

import {
    CANONICAL_FAILURE_CODES,
    classifyFailure,
    type FailureClassification,
} from '../behavior/failure-taxonomy';

/** First backoff step (attempt 1 → next wait). */
export const DEFAULT_PROVIDER_RETRY_BASE_DELAY_MS = 1_000;

/** Ceiling between retries for indefinite rate-limit / usage waits (~30 minutes). */
export const DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS = 30 * 60 * 1_000;

/** Finite retry budget for ordinary retryable errors (timeouts, transient network). */
export const DEFAULT_PROVIDER_RETRY_LIMIT = 7;

const USAGE_EXHAUSTION_MESSAGE_MARKERS = [
    'insufficient_quota',
    'quota exceeded',
    'quota_exceeded',
    'usage limit',
    'usage_limit',
    'resource_exhausted',
    'resource exhausted',
    'billing hard limit',
    'exceeded your current quota',
    'monthly limit',
    'daily limit',
    'tokens per day',
    'token limit',
    'credit balance is too low',
    'out of credits',
    'payment required',
] as const;

/**
 * Exponential backoff: base * 2^(retryNumber-1), capped at maxMs.
 * `retryNumber` is 1-based (first retry after attempt 1 uses exponent 0).
 */
export function computeProviderRetryDelayMs(retryNumber: number, baseMs: number, maxMs: number): number {
    if (retryNumber < 1 || baseMs <= 0 || maxMs <= 0) {
        return 0;
    }
    const exponent = Math.min(retryNumber - 1, 30);
    const candidate = baseMs * 2 ** exponent;
    if (!Number.isFinite(candidate)) {
        return maxMs;
    }
    return Math.min(maxMs, candidate);
}

/**
 * True when the failure should wait indefinitely (rate limit / overload / usage quota)
 * instead of burning a finite node or provider attempt budget.
 */
export function isIndefiniteProviderWaitError(error: unknown): boolean {
    const classified = classifyFailure(error);
    if (isIndefiniteProviderWaitClassification(classified)) {
        return true;
    }
    return hasUsageExhaustionSignal(error);
}

export function isIndefiniteProviderWaitClassification(classification: FailureClassification): boolean {
    if (classification.code === CANONICAL_FAILURE_CODES.PROVIDER_RATE_LIMITED) {
        return true;
    }
    if (classification.code === CANONICAL_FAILURE_CODES.PROVIDER_USAGE_EXHAUSTED) {
        return true;
    }
    return false;
}

/**
 * Whether a retryable failure may continue past `retryLimit`.
 * Indefinite waits (rate limit / usage) return true; ordinary retryables return false.
 */
export function shouldContinueProviderRetry(input: {
    readonly error: unknown;
    readonly attempt: number;
    readonly maxAttempts: number;
}): boolean {
    if (isIndefiniteProviderWaitError(input.error)) {
        return true;
    }
    const classified = classifyFailure(input.error);
    if (!classified.retryable) {
        return false;
    }
    return input.attempt < input.maxAttempts;
}

export function hasUsageExhaustionSignal(error: unknown): boolean {
    const text = collectErrorText(error).toLowerCase();
    if (text.length === 0) {
        return false;
    }
    return USAGE_EXHAUSTION_MESSAGE_MARKERS.some((marker) => text.includes(marker));
}

export async function abortableRetrySleep(ms: number, signal: AbortSignal | undefined): Promise<void> {
    if (ms <= 0) {
        return;
    }
    if (signal?.aborted === true) {
        return;
    }
    await new Promise<void>((resolve) => {
        const onAbort = (): void => {
            clearTimeout(timer);
            resolve();
        };
        const timer = setTimeout(() => {
            if (signal !== undefined) {
                signal.removeEventListener('abort', onAbort);
            }
            resolve();
        }, ms);
        if (signal !== undefined) {
            signal.addEventListener('abort', onAbort, { once: true });
        }
    });
}

function collectErrorText(error: unknown): string {
    const parts: string[] = [];
    const seen = new Set<unknown>();
    let current: unknown = error;
    while (current !== undefined && current !== null && !seen.has(current)) {
        seen.add(current);
        if (typeof current === 'string') {
            parts.push(current);
            break;
        }
        if (typeof current !== 'object') {
            break;
        }
        if ('message' in current && typeof current.message === 'string') {
            parts.push(current.message);
        }
        if ('code' in current && typeof current.code === 'string') {
            parts.push(current.code);
        }
        if ('lastError' in current) {
            current = current.lastError;
            continue;
        }
        if ('cause' in current) {
            current = current.cause;
            continue;
        }
        if ('error' in current) {
            current = current.error;
            continue;
        }
        break;
    }
    return parts.join('\n');
}
