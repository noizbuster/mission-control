import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { noProviderMessage, selectWebSearchProvider } from './web-search-transport.js';

const keys = ['EXA_API_KEY', 'PARALLEL_API_KEY'] as const;
const previous: Record<string, string | undefined> = {};

beforeEach(() => {
    for (const key of keys) {
        previous[key] = process.env[key];
        delete process.env[key];
    }
});

afterEach(() => {
    for (const key of keys) {
        const value = previous[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
    }
});

describe('selectWebSearchProvider', () => {
    it('selects exa, parallel, or nothing from configured keys', () => {
        expect(selectWebSearchProvider()).toBeUndefined();
        process.env['PARALLEL_API_KEY'] = 'parallel-test-key';
        expect(selectWebSearchProvider()).toBe('parallel');
        process.env['EXA_API_KEY'] = 'exa-test-key';
        expect(selectWebSearchProvider()).toBe('exa');
    });
});

describe('noProviderMessage', () => {
    it('lists the supported credential env vars', () => {
        const message = noProviderMessage();
        expect(message).toContain('EXA_API_KEY');
        expect(message).toContain('PARALLEL_API_KEY');
        expect(message).toContain('BRAVE_API_KEY');
        expect(message).toContain('SEARXNG_ENDPOINT');
    });
});
