import { describe, expect, it } from 'vitest';
import {
    computeProviderRetryDelayMs,
    DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS,
    isIndefiniteProviderWaitError,
    shouldContinueProviderRetry,
} from './provider-retry-policy';

describe('provider-retry-policy', () => {
    it('grows exponential backoff and caps near 30 minutes', () => {
        expect(computeProviderRetryDelayMs(1, 1_000, DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS)).toBe(1_000);
        expect(computeProviderRetryDelayMs(2, 1_000, DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS)).toBe(2_000);
        expect(computeProviderRetryDelayMs(3, 1_000, DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS)).toBe(4_000);
        expect(computeProviderRetryDelayMs(20, 1_000, DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS)).toBe(
            DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS,
        );
    });

    it('treats overload and quota messages as indefinite waits', () => {
        expect(
            isIndefiniteProviderWaitError({
                message: 'The service may be temporarily overloaded, please try again later',
                retryable: false,
            }),
        ).toBe(true);
        expect(
            isIndefiniteProviderWaitError({
                code: 'insufficient_quota',
                message: 'You exceeded your current quota',
            }),
        ).toBe(true);
        expect(
            isIndefiniteProviderWaitError({
                code: 'provider_rate_limited',
                message: 'rate limited',
                retryable: true,
            }),
        ).toBe(true);
    });

    it('keeps ordinary retryables under the finite attempt budget', () => {
        expect(
            shouldContinueProviderRetry({
                error: { code: 'provider_timeout', message: 'fetch failed', retryable: true },
                attempt: 3,
                maxAttempts: 8,
            }),
        ).toBe(true);
        expect(
            shouldContinueProviderRetry({
                error: { code: 'provider_timeout', message: 'fetch failed', retryable: true },
                attempt: 8,
                maxAttempts: 8,
            }),
        ).toBe(false);
    });

    it('continues rate-limit waits past maxAttempts', () => {
        expect(
            shouldContinueProviderRetry({
                error: {
                    code: 'provider_rate_limited',
                    message: 'temporarily overloaded',
                    retryable: true,
                },
                attempt: 100,
                maxAttempts: 8,
            }),
        ).toBe(true);
    });
});
