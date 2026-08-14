import { describe, expect, it } from 'vitest';
import { parseRetryAfterHeader, retryAfterMsFromError, retryAfterMsFromResponse } from './retry-after';

function responseWithHeaders(headers: Readonly<Record<string, string>>): {
    readonly headers: { readonly get: (name: string) => string | null };
} {
    const lowered: Record<string, string> = {};
    for (const [key, value] of Object.entries(headers)) {
        lowered[key.toLowerCase()] = value;
    }
    return {
        headers: {
            get: (name: string) => lowered[name.toLowerCase()] ?? null,
        },
    };
}
describe('parseRetryAfterHeader', () => {
    it('parses delta-seconds values into milliseconds', () => {
        expect(parseRetryAfterHeader('5')).toBe(5_000);
        expect(parseRetryAfterHeader('0.5')).toBe(500);
        expect(parseRetryAfterHeader(' 12 ')).toBe(12_000);
    });

    it('rejects HTTP-dates, empty, negative, and absurd values', () => {
        expect(parseRetryAfterHeader('Wed, 21 Oct 2026 07:28:00 GMT')).toBeUndefined();
        expect(parseRetryAfterHeader('')).toBeUndefined();
        expect(parseRetryAfterHeader('-1')).toBeUndefined();
        expect(parseRetryAfterHeader('999999999')).toBeUndefined();
        expect(parseRetryAfterHeader(null)).toBeUndefined();
        expect(parseRetryAfterHeader(undefined)).toBeUndefined();
    });
});

describe('retryAfterMsFromResponse', () => {
    it('reads the retry-after header case-insensitively', () => {
        expect(retryAfterMsFromResponse(responseWithHeaders({ 'retry-after': '3' }))).toBe(3_000);
        expect(retryAfterMsFromResponse(responseWithHeaders({ 'Retry-After': '8' }))).toBe(8_000);
    });

    it('returns undefined when the header is absent', () => {
        expect(retryAfterMsFromResponse(responseWithHeaders({}))).toBeUndefined();
    });
});

describe('retryAfterMsFromError', () => {
    it('reads a retryAfterMs field off transport errors and protocol errors', () => {
        const error = new Error('rate limited');
        Object.assign(error, { retryAfterMs: 25_000 });
        expect(retryAfterMsFromError(error)).toBe(25_000);
    });

    it('reads responseHeaders carrying retry-after (AI SDK APICallError shape)', () => {
        const error = new Error('429') as Error & { responseHeaders: Record<string, string> };
        error.responseHeaders = { 'retry-after': '7' };
        expect(retryAfterMsFromError(error)).toBe(7_000);
    });

    it('walks a bounded cause chain', () => {
        const root = new Error('fetch failed') as Error & { responseHeaders: Record<string, string> };
        root.responseHeaders = { 'retry-after': '2' };
        const wrapped = new Error('provider call failed', { cause: root });
        expect(retryAfterMsFromError(wrapped)).toBe(2_000);
    });

    it('returns undefined for errors without advisory data', () => {
        expect(retryAfterMsFromError(new Error('plain'))).toBeUndefined();
        expect(retryAfterMsFromError(undefined)).toBeUndefined();
        expect(retryAfterMsFromError('string error')).toBeUndefined();
    });
});
