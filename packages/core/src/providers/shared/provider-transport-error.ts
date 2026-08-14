import type { ProtocolError } from '@mission-control/protocol';

/**
 * Structural view of a provider transport error. Every provider's
 * `<Provider>TransportError` (anthropic, openai, openai-compatible, gemini)
 * exposes the same `kind` / `status` / `code` / `message` shape, so an instance
 * can be passed here directly.
 */
export interface ProviderTransportErrorInfo {
    readonly kind?: string;
    readonly status?: number;
    readonly code?: string;
    /** Server-advised retry delay (HTTP `Retry-After`) in ms, when sent. */
    readonly retryAfterMs?: number;
}

/**
 * Parameterizes the transport-error → {@link ProtocolError} mapping. The
 * decision tree is evaluated in a fixed order (abort → timeout-kind → auth →
 * rate-limit → timeout-code → context-overflow → network-message → unknown) so
 * that each provider's EXACT status-code → code mapping and retry behavior is
 * preserved — including intentional asymmetries (e.g. anthropic does not treat
 * 502/503/504 as rate-limited, unlike the other three).
 */
export interface ProviderTransportErrorOptions {
    /** Transport `kind` values treated as timeouts (→ `provider_timeout`, retryable). Defaults to `['timeout']`; openai-compatible also maps `'network'`. */
    readonly timeoutKinds?: readonly string[];
    /** HTTP status codes mapped to `provider_auth_failed` (non-retryable). All providers: `[401, 403]`. */
    readonly authStatusCodes: readonly number[];
    /** Transport `code` values mapped to `provider_auth_failed`. Gemini: `['UNAUTHENTICATED']`. */
    readonly authCodes?: readonly string[];
    /** HTTP status codes mapped to `provider_rate_limited` (retryable). Anthropic: `[429, 529]` (no 502/503/504); the others additionally list `502`/`503`/`504`/`529`. */
    readonly rateLimitStatusCodes: readonly number[];
    /** When true, any status in `[500, 600)` is also rate-limited. Anthropic: `false`; the others: `true`. */
    readonly rateLimitOn5xx?: boolean;
    /** Transport `code` values mapped to `provider_rate_limited`. Gemini: `['RESOURCE_EXHAUSTED']`. */
    readonly rateLimitCodes?: readonly string[];
    /** Case-insensitive message substrings mapped to `provider_rate_limited`. */
    readonly rateLimitMessageSubstrings?: readonly string[];
    /** Transport `code` values mapped to `provider_timeout` (checked AFTER rate-limit). Gemini: `['DEADLINE_EXCEEDED']`. */
    readonly timeoutCodes?: readonly string[];
    /** Predicate over `(info, redactedMessage)` selecting `provider_context_overflow` (non-retryable). */
    readonly contextOverflow?: (info: ProviderTransportErrorInfo, message: string) => boolean;
    /** Predicate over the redacted message selecting `provider_timeout` for network-style failures (openai-compatible only). */
    readonly networkMessagePredicate?: (message: string) => boolean;
}

/**
 * Maps a provider transport error to a {@link ProtocolError}.
 *
 * `redactedMessage` is the already-redacted transport message (redaction stays
 * provider-specific); `error` supplies `kind`/`status`/`code`. The fixed
 * evaluation order preserves each provider's exact retry behavior — see
 * {@link ProviderTransportErrorOptions}.
 */
export function mapProviderTransportError(
    error: ProviderTransportErrorInfo,
    redactedMessage: string,
    options: ProviderTransportErrorOptions,
): ProtocolError {
    const timeoutKinds = options.timeoutKinds ?? DEFAULT_TIMEOUT_KINDS;
    const status = error.status;
    const code = error.code;
    const retryAfterMs = error.retryAfterMs;
    const withRetryAfter = (base: ProtocolError): ProtocolError =>
        retryAfterMs !== undefined ? { ...base, retryAfterMs } : base;

    if (error.kind === 'abort') {
        return { code: 'provider_aborted', message: redactedMessage, retryable: false };
    }
    if (error.kind !== undefined && timeoutKinds.includes(error.kind)) {
        return withRetryAfter({ code: 'provider_timeout', message: redactedMessage, retryable: true });
    }
    if (status !== undefined && options.authStatusCodes.includes(status)) {
        return { code: 'provider_auth_failed', message: redactedMessage, retryable: false };
    }
    if (code !== undefined && options.authCodes?.includes(code) === true) {
        return { code: 'provider_auth_failed', message: redactedMessage, retryable: false };
    }
    if (isRateLimited(status, code, redactedMessage, options)) {
        return withRetryAfter({ code: 'provider_rate_limited', message: redactedMessage, retryable: true });
    }
    if (code !== undefined && options.timeoutCodes?.includes(code) === true) {
        return withRetryAfter({ code: 'provider_timeout', message: redactedMessage, retryable: true });
    }
    if (options.contextOverflow?.(error, redactedMessage) === true) {
        return { code: 'provider_context_overflow', message: redactedMessage, retryable: false };
    }
    if (options.networkMessagePredicate?.(redactedMessage) === true) {
        return withRetryAfter({ code: 'provider_timeout', message: redactedMessage, retryable: true });
    }
    return { code: 'unknown', message: redactedMessage, retryable: false };
}

const DEFAULT_TIMEOUT_KINDS: readonly string[] = ['timeout'];

function isRateLimited(
    status: number | undefined,
    code: string | undefined,
    redactedMessage: string,
    options: ProviderTransportErrorOptions,
): boolean {
    if (status !== undefined && options.rateLimitStatusCodes.includes(status)) {
        return true;
    }
    if (options.rateLimitOn5xx === true && status !== undefined && status >= 500 && status < 600) {
        return true;
    }
    if (code !== undefined && options.rateLimitCodes?.includes(code) === true) {
        return true;
    }
    if (
        options.rateLimitMessageSubstrings !== undefined &&
        messageIncludesAny(redactedMessage, options.rateLimitMessageSubstrings)
    ) {
        return true;
    }
    return false;
}

function messageIncludesAny(message: string, substrings: readonly string[]): boolean {
    const lower = message.toLowerCase();
    return substrings.some((substring) => lower.includes(substring));
}
