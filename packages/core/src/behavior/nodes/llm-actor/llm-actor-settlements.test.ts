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
});
