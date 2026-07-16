import { describe, expect, it } from 'vitest';
import { classifyProviderStreamError } from './llm-actor-settlements';

describe('classifyProviderStreamError', () => {
    it('maps AI SDK isRetryable + statusCode 503 to retryable rate limit', () => {
        const classified = classifyProviderStreamError({
            message: 'The service may be temporarily overloaded, please try again later',
            statusCode: 503,
            isRetryable: false,
        });
        expect(classified).toEqual({ code: 'provider_rate_limited', retryable: true });
    });

    it('maps overload message without status to retryable rate limit', () => {
        const classified = classifyProviderStreamError({
            message: 'The service may be temporarily overloaded, please try again later',
        });
        expect(classified).toEqual({ code: 'provider_rate_limited', retryable: true });
    });

    it('maps AI SDK isRetryable true when no status is present', () => {
        const classified = classifyProviderStreamError({
            message: 'network glitch',
            isRetryable: true,
        });
        expect(classified).toEqual({ code: 'unknown', retryable: true });
    });

    it('keeps auth failures non-retryable', () => {
        const classified = classifyProviderStreamError({
            message: 'invalid api key',
            statusCode: 401,
            isRetryable: false,
        });
        expect(classified).toEqual({ code: 'provider_auth_failed', retryable: false });
    });

    it('reads nested FlatProviderBridgeError shape', () => {
        const classified = classifyProviderStreamError({
            error: {
                code: 'provider_rate_limited',
                message: 'overloaded',
                retryable: true,
            },
        });
        expect(classified).toEqual({ code: 'provider_rate_limited', retryable: true });
    });

    it('overrides explicit non-retryable when message is transient overload', () => {
        const classified = classifyProviderStreamError({
            code: 'unknown',
            message: 'The service may be temporarily overloaded, please try again later',
            retryable: false,
        });
        expect(classified).toEqual({ code: 'provider_rate_limited', retryable: true });
    });

    it('unwraps AI SDK RetryError.lastError for overload classification', () => {
        const classified = classifyProviderStreamError({
            name: 'AI_RetryError',
            reason: 'maxRetriesExceeded',
            message: 'Failed after 3 attempts. Last error: The service may be temporarily overloaded, please try again later',
            lastError: {
                message: 'The service may be temporarily overloaded, please try again later',
                statusCode: 503,
                isRetryable: false,
            },
        });
        expect(classified).toEqual({ code: 'provider_rate_limited', retryable: true });
    });

    it('maps TypeError fetch failed as retryable provider_timeout', () => {
        const classified = classifyProviderStreamError(
            Object.assign(new TypeError('fetch failed'), { isRetryable: false }),
        );
        expect(classified).toEqual({ code: 'provider_timeout', retryable: true });
    });

    it('maps AI SDK fetch-failed message with isRetryable false as retryable', () => {
        const classified = classifyProviderStreamError({
            name: 'AI_APICallError',
            message: 'TypeError: fetch failed',
            isRetryable: false,
        });
        expect(classified).toEqual({ code: 'provider_timeout', retryable: true });
    });

    it('unwraps undici cause codes on fetch failures as retryable', () => {
        const cause = Object.assign(new Error('connect ECONNRESET'), { code: 'ECONNRESET' });
        const classified = classifyProviderStreamError(
            Object.assign(new TypeError('fetch failed'), { cause, isRetryable: false }),
        );
        expect(classified).toEqual({ code: 'provider_timeout', retryable: true });
    });

    it('maps undici connect timeout code as retryable', () => {
        const classified = classifyProviderStreamError({
            message: 'Connect Timeout Error',
            code: 'UND_ERR_CONNECT_TIMEOUT',
            isRetryable: false,
        });
        expect(classified).toEqual({ code: 'provider_timeout', retryable: true });
    });
});
