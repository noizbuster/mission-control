import { describe, expect, it } from 'vitest';
import {
    computeProviderRetryDelayMs,
    DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS,
    isIndefiniteProviderWaitError,
    providerRetryDelayMs,
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

    it('uses Retry-After as a floor over the backoff, capped at maxMs', () => {
        // Advisory above the first backoff step wins.
        expect(
            providerRetryDelayMs({ attempt: 1, baseMs: 1_000, maxMs: 30_000, retryAfterMs: 20_000 }),
        ).toBe(20_000);
        // Advisory below the backoff step does not shorten the wait.
        expect(providerRetryDelayMs({ attempt: 5, baseMs: 1_000, maxMs: 30_000, retryAfterMs: 2_000 })).toBe(
            16_000,
        );
        // Advisory cannot extend past the cap.
        expect(
            providerRetryDelayMs({
                attempt: 1,
                baseMs: 1_000,
                maxMs: 30_000,
                retryAfterMs: DEFAULT_PROVIDER_MAX_RETRY_DELAY_MS,
            }),
        ).toBe(30_000);
        // No advisory → plain backoff.
        expect(providerRetryDelayMs({ attempt: 2, baseMs: 1_000, maxMs: 30_000 })).toBe(2_000);
        // Non-positive advisory is ignored.
        expect(providerRetryDelayMs({ attempt: 1, baseMs: 1_000, maxMs: 30_000, retryAfterMs: 0 })).toBe(1_000);
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
