import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { WebSearchInput } from './web-search-schemas.js';
import {
    executeWebSearch,
    type WebSearchTransportOptions,
} from './web-search-transport.js';

const ALL_PROVIDER_KEYS: Array<[string, string]> = [
    ['EXA_API_KEY', 'exa-key'],
    ['BRAVE_API_KEY', 'brave-key'],
    ['JINA_API_KEY', 'jina-key'],
    ['TAVILY_API_KEY', 'tavily-key'],
    ['PARALLEL_API_KEY', 'parallel-key'],
    ['PERPLEXITY_API_KEY', 'perplexity-key'],
    ['ANTHROPIC_API_KEY', 'anthropic-key'],
    ['GEMINI_API_KEY', 'gemini-key'],
    ['OPENAI_API_KEY', 'openai-key'],
    ['ZAI_API_KEY', 'zai-key'],
    ['MOONSHOT_SEARCH_API_KEY', 'kimi-key'],
    ['KAGI_API_KEY', 'kagi-key'],
    ['SYNTHETIC_API_KEY', 'synthetic-key'],
    ['SEARXNG_ENDPOINT', 'https://searx.test'],
];

describe('executeWebSearch — auto chain', () => {
    let originalFetch: typeof globalThis.fetch;
    const previous: Record<string, string | undefined> = {};

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        for (const [key] of ALL_PROVIDER_KEYS) {
            previous[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        for (const [key, value] of ALL_PROVIDER_KEYS) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key]!;
        }
        vi.useRealTimers();
    });

    const sampleInput: WebSearchInput = { query: 'test query' };
    const autoOptions: WebSearchTransportOptions = { sessionId: 'session-test' };

    it('throws a helpful no-provider error when nothing is configured', async () => {
        await expect(executeWebSearch(sampleInput, autoOptions)).rejects.toThrow(/No web search provider configured/);
    });

    it('walks the chain and uses the first available provider (exa)', async () => {
        process.env['EXA_API_KEY'] = 'exa-secret-key';
        globalThis.fetch = jsonFetch(
            JSON.stringify({
                results: [
                    { title: 'Exa Result', url: 'https://a.test', summary: 'summary text' },
                    { title: 'Second', url: 'https://b.test' },
                ],
            }),
        );

        const output = await executeWebSearch(sampleInput, autoOptions);

        expect(output.provider).toBe('exa');
        expect(output.results).toHaveLength(2);
        expect(output.results[0]?.title).toBe('Exa Result');
        expect(output.results[0]?.url).toBe('https://a.test');
        expect(output.results[0]?.content).toBe('summary text');
    });

    it('falls through to the next provider when the first fails', async () => {
        process.env['EXA_API_KEY'] = 'exa-key';
        process.env['BRAVE_API_KEY'] = 'brave-key';
        let callCount = 0;
        globalThis.fetch = ((_url, _init) => {
            callCount += 1;
            if (callCount === 1) {
                return Promise.resolve(new Response('error', { status: 500 }));
            }
            return Promise.resolve(
                new Response(
                    JSON.stringify({
                        web: { results: [{ title: 'Brave Fallback', url: 'https://brave.test' }] },
                    }),
                    { status: 200, headers: { 'content-type': 'application/json' } },
                ),
            );
        }) as typeof globalThis.fetch;

        const output = await executeWebSearch(sampleInput, autoOptions);

        expect(output.provider).toBe('brave');
        expect(output.results[0]?.title).toBe('Brave Fallback');
    });

    it('throws a combined failure message when all providers in the chain fail', async () => {
        process.env['EXA_API_KEY'] = 'exa-key';
        globalThis.fetch = jsonFetch('error', 500);

        await expect(executeWebSearch(sampleInput, autoOptions)).rejects.toThrow(
            /All configured web search providers failed/,
        );
    });

    it('redacts the API key from the output when it appears in a result field', async () => {
        process.env['EXA_API_KEY'] = 'super-secret-key-12345';
        globalThis.fetch = jsonFetch(
            JSON.stringify({
                results: [{ title: 'super-secret-key-12345 leaked here', url: 'https://a.test' }],
            }),
        );

        const output = await executeWebSearch(sampleInput, autoOptions);

        expect(output.results[0]?.title).toBe('[REDACTED_CREDENTIAL] leaked here');
    });

    it('redacts the API key from the combined failure message', async () => {
        process.env['EXA_API_KEY'] = 'super-secret-key-12345';
        globalThis.fetch = jsonFetch('error body super-secret-key-12345', 500);

        await expect(executeWebSearch(sampleInput, autoOptions)).rejects.toThrow(/\[REDACTED_CREDENTIAL\]/u);
    });

    it('throws a timeout error after the 25s deadline elapses', async () => {
        vi.useFakeTimers();
        process.env['EXA_API_KEY'] = 'exa-key';
        globalThis.fetch = hangingFetch;

        const expectation = expect(executeWebSearch(sampleInput, autoOptions)).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(25_000);
        await expectation;
    });
});

describe('executeWebSearch — explicit provider pinning', () => {
    let originalFetch: typeof globalThis.fetch;
    const previous: Record<string, string | undefined> = {};

    beforeEach(() => {
        originalFetch = globalThis.fetch;
        for (const [key] of ALL_PROVIDER_KEYS) {
            previous[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        globalThis.fetch = originalFetch;
        for (const [key, value] of ALL_PROVIDER_KEYS) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key]!;
        }
    });

    const sampleInput: WebSearchInput = { query: 'test query' };

    it('pins brave when provider is set to brave and key is configured', async () => {
        process.env['EXA_API_KEY'] = 'exa-key';
        process.env['BRAVE_API_KEY'] = 'brave-key';
        let capturedUrl = '';
        globalThis.fetch = ((url, _init) => {
            capturedUrl = String(url);
            return Promise.resolve(
                new Response(JSON.stringify({ web: { results: [{ title: 'Brave', url: 'https://b.test' }] } }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            );
        }) as typeof globalThis.fetch;

        const output = await executeWebSearch(sampleInput, {
            provider: 'brave',
            sessionId: 'session-test',
        });

        expect(output.provider).toBe('brave');
        expect(capturedUrl).toContain('api.search.brave.com');
    });

    it('builds parallel request with objective and search_queries', async () => {
        process.env['PARALLEL_API_KEY'] = 'parallel-key';
        let capturedBody = '';
        globalThis.fetch = ((_url, init) => {
            if (init?.body !== undefined) capturedBody = String(init.body);
            return Promise.resolve(
                new Response(JSON.stringify({ results: [{ title: 'Parallel', url: 'https://p.test' }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            );
        }) as typeof globalThis.fetch;

        await executeWebSearch(sampleInput, { provider: 'parallel', sessionId: 'session-parallel' });

        const parsed = captureSchema.parse(JSON.parse(capturedBody));
        expect(parsed.objective).toBe('test query');
        expect(parsed.search_queries).toEqual(['test query']);
        expect(parsed.mode).toBe('fast');
    });

    it('pins tavily and parses answer + results', async () => {
        process.env['TAVILY_API_KEY'] = 'tavily-key';
        globalThis.fetch = jsonFetch(
            JSON.stringify({
                answer: 'Tavily synthesized answer',
                results: [{ title: 'Tavily', url: 'https://t.test', content: 'snippet' }],
            }),
        );

        const output = await executeWebSearch(sampleInput, { provider: 'tavily', sessionId: 's' });

        expect(output.provider).toBe('tavily');
        expect(output.answer).toBe('Tavily synthesized answer');
        expect(output.results[0]?.title).toBe('Tavily');
    });

    it('pins jina and parses the data array', async () => {
        process.env['JINA_API_KEY'] = 'jina-key';
        globalThis.fetch = jsonFetch(
            JSON.stringify({ data: [{ title: 'Jina', url: 'https://j.test', content: 'jina content' }] }),
        );

        const output = await executeWebSearch(sampleInput, { provider: 'jina', sessionId: 's' });

        expect(output.provider).toBe('jina');
        expect(output.results[0]?.title).toBe('Jina');
        expect(output.results[0]?.content).toBe('jina content');
    });

    it('pins searxng using SEARXNG_ENDPOINT', async () => {
        process.env['SEARXNG_ENDPOINT'] = 'https://searx.test';
        let capturedUrl = '';
        globalThis.fetch = ((url, _init) => {
            capturedUrl = String(url);
            return Promise.resolve(
                new Response(JSON.stringify({ results: [{ title: 'SearX', url: 'https://sx.test', content: 'x' }] }), {
                    status: 200,
                    headers: { 'content-type': 'application/json' },
                }),
            );
        }) as typeof globalThis.fetch;

        const output = await executeWebSearch(sampleInput, { provider: 'searxng', sessionId: 's' });

        expect(output.provider).toBe('searxng');
        expect(capturedUrl).toContain('searx.test/search');
        expect(output.results[0]?.title).toBe('SearX');
    });
});

function jsonFetch(body: string, status = 200): typeof globalThis.fetch {
    return () =>
        Promise.resolve(
            new Response(body, {
                status,
                headers: { 'content-type': 'application/json' },
            }),
        );
}

function hangingFetch(_input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
}

const captureSchema = z.object({
    objective: z.string(),
    search_queries: z.array(z.string()),
    mode: z.string(),
});
