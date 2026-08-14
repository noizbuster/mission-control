/**
 * HTTP `Retry-After` extraction for provider retries (omp `ai` error-taxonomy
 * pattern: retry guidance must come from structured error data, never message
 * regexes).
 *
 * Only delta-seconds is parsed. The HTTP-date form is rare on model APIs and
 * adds date-parsing ambiguity; when it appears the header is ignored and the
 * exponential backoff applies.
 */

/** Maximum header value (in seconds) treated as meaningful; beyond this the header is ignored. */
const MAX_RETRY_AFTER_SECONDS = 24 * 60 * 60;
const MILLISECONDS_PER_SECOND = 1_000;

/** Parse a raw `Retry-After` header value into milliseconds. */
export function parseRetryAfterHeader(value: string | null | undefined): number | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    if (trimmed.length === 0 || !/^\d+(?:\.\d+)?$/u.test(trimmed)) return undefined;
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds) || seconds <= 0 || seconds > MAX_RETRY_AFTER_SECONDS) return undefined;
    const ms = seconds * MILLISECONDS_PER_SECOND;
    return Number.isInteger(ms) ? ms : Math.ceil(ms);
}

export type RetryAfterResponse = {
    readonly headers: { readonly get: (name: string) => string | null };
};

/** Read `Retry-After` off a fetch `Response`-like object. */
export function retryAfterMsFromResponse(response: RetryAfterResponse): number | undefined {
    return (
        parseRetryAfterHeader(response.headers.get('retry-after')) ??
        parseRetryAfterHeader(response.headers.get('Retry-After'))
    );
}

/** Cause-chain walk bound; provider wrappers are shallow (chunk → bridge → SDK). */
const MAX_CAUSE_DEPTH = 5;

function retryAfterFromHeaders(value: unknown): number | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const record = value as Readonly<Record<string, unknown>>;
    for (const key of ['retry-after', 'Retry-After']) {
        const raw = record[key];
        if (typeof raw === 'string') {
            const parsed = parseRetryAfterHeader(raw);
            if (parsed !== undefined) return parsed;
        }
    }
    return undefined;
}

/**
 * Extract a server-advised retry delay from an arbitrary provider error.
 * Recognizes, walking a bounded `cause` chain:
 *   - a `retryAfterMs` number property (mc transport errors, `ProtocolError`),
 *   - a `responseHeaders` record carrying `retry-after` (AI SDK `APICallError`).
 */
export function retryAfterMsFromError(error: unknown): number | undefined {
    let current: unknown = error;
    for (let depth = 0; depth < MAX_CAUSE_DEPTH && typeof current === 'object' && current !== null; depth += 1) {
        const record = current as Readonly<Record<string, unknown>>;
        const own = record['retryAfterMs'];
        if (typeof own === 'number' && Number.isFinite(own) && own > 0) {
            return own;
        }
        const fromHeaders = retryAfterFromHeaders(record['responseHeaders']);
        if (fromHeaders !== undefined) {
            return fromHeaders;
        }
        current = record['cause'];
    }
    return undefined;
}
