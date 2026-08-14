import { describe, expect, it } from 'vitest';
import { mapProviderTransportError, type ProviderTransportErrorOptions } from './provider-transport-error';

const OPTIONS: ProviderTransportErrorOptions = {
    authStatusCodes: [401, 403],
    rateLimitStatusCodes: [429, 502, 503, 504, 529],
    rateLimitOn5xx: true,
};

describe('mapProviderTransportError retry-after propagation', () => {
    it('carries retryAfterMs onto retryable rate-limit mappings', () => {
        const mapped = mapProviderTransportError({ status: 429, retryAfterMs: 15_000 }, 'rate limited', OPTIONS);
        expect(mapped).toMatchObject({
            code: 'provider_rate_limited',
            retryable: true,
            retryAfterMs: 15_000,
        });
    });

    it('carries retryAfterMs onto retryable timeout mappings', () => {
        const mapped = mapProviderTransportError({ kind: 'timeout', retryAfterMs: 4_000 }, 'timed out', OPTIONS);
        expect(mapped).toMatchObject({ code: 'provider_timeout', retryable: true, retryAfterMs: 4_000 });
    });

    it('does not attach retryAfterMs to non-retryable mappings', () => {
        const mapped = mapProviderTransportError({ status: 401, retryAfterMs: 1_000 }, 'invalid key', OPTIONS);
        expect(mapped).toEqual({ code: 'provider_auth_failed', message: 'invalid key', retryable: false });
    });

    it('omits the field when the transport sent no advisory', () => {
        const mapped = mapProviderTransportError({ status: 503 }, 'overloaded', OPTIONS);
        expect(mapped).toEqual({ code: 'provider_rate_limited', message: 'overloaded', retryable: true });
    });
});
