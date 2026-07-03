import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { allWebSearchProviders, getWebSearchProvider, resolveProviderChain } from './web-search-providers.js';
import { WEB_SEARCH_PROVIDER_IDS } from './web-search-schemas.js';

const ALL_PROVIDER_KEYS: Array<[string, string]> = [
    ['EXA_API_KEY', 'exa-key'],
    ['BRAVE_API_KEY', 'brave-key'],
    ['JINA_API_KEY', 'jina-key'],
    ['MOONSHOT_SEARCH_API_KEY', 'kimi-key'],
    ['ZAI_API_KEY', 'zai-key'],
    ['ANTHROPIC_API_KEY', 'anthropic-key'],
    ['PERPLEXITY_API_KEY', 'perplexity-key'],
    ['GEMINI_API_KEY', 'gemini-key'],
    ['OPENAI_API_KEY', 'openai-key'],
    ['TAVILY_API_KEY', 'tavily-key'],
    ['PARALLEL_API_KEY', 'parallel-key'],
    ['KAGI_API_KEY', 'kagi-key'],
    ['SYNTHETIC_API_KEY', 'synthetic-key'],
    ['SEARXNG_ENDPOINT', 'https://searx.test'],
];

describe('web-search-providers registry', () => {
    const previous: Record<string, string | undefined> = {};

    beforeEach(() => {
        for (const [key] of ALL_PROVIDER_KEYS) {
            previous[key] = process.env[key];
            delete process.env[key];
        }
    });

    afterEach(() => {
        for (const [key, value] of ALL_PROVIDER_KEYS) {
            if (previous[key] === undefined) delete process.env[key];
            else process.env[key] = previous[key]!;
        }
    });

    it('registers exactly the 14 providers in WEB_SEARCH_PROVIDER_IDS order', () => {
        const providers = allWebSearchProviders();
        expect(providers).toHaveLength(14);
        expect(providers.map((p) => p.id)).toEqual([...WEB_SEARCH_PROVIDER_IDS]);
    });

    it('every provider is resolvable by id', () => {
        for (const id of WEB_SEARCH_PROVIDER_IDS) {
            const provider = getWebSearchProvider(id);
            expect(provider).toBeDefined();
            expect(provider!.id).toBe(id);
            expect(provider!.label.length).toBeGreaterThan(0);
        }
    });

    it('returns an empty chain when no credentials are configured', () => {
        expect(resolveProviderChain('auto')).toHaveLength(0);
    });

    it('admits only configured providers into the auto chain in order', () => {
        process.env['BRAVE_API_KEY'] = 'brave-key';
        process.env['TAVILY_API_KEY'] = 'tavily-key';

        const chain = resolveProviderChain('auto');
        const ids = chain.map((p) => p.id);
        expect(ids).toEqual(['brave', 'tavily']);
    });

    it('places the preferred provider first when it is available', () => {
        process.env['EXA_API_KEY'] = 'exa-key';
        process.env['BRAVE_API_KEY'] = 'brave-key';
        process.env['TAVILY_API_KEY'] = 'tavily-key';

        const chain = resolveProviderChain('tavily');
        const ids = chain.map((p) => p.id);
        expect(ids[0]).toBe('tavily');
        expect(ids).toContain('exa');
        expect(ids).toContain('brave');
    });

    it('gates each provider on its credential env var', () => {
        for (const [id] of WEB_SEARCH_PROVIDER_IDS.map((id) => [id] as const)) {
            const provider = getWebSearchProvider(id)!;
            expect(provider.isAvailable()).toBe(false);
        }

        process.env['JINA_API_KEY'] = 'jina-key';
        const jina = getWebSearchProvider('jina')!;
        expect(jina.isAvailable()).toBe(true);

        const kimiWithSearch = getWebSearchProvider('kimi')!;
        expect(kimiWithSearch.isAvailable()).toBe(false);
        process.env['MOONSHOT_SEARCH_API_KEY'] = 'ms-key';
        expect(kimiWithSearch.isAvailable()).toBe(true);
    });

    it('searxng gates on SEARXNG_ENDPOINT (not an API key)', () => {
        const searxng = getWebSearchProvider('searxng')!;
        expect(searxng.isAvailable()).toBe(false);
        process.env['SEARXNG_ENDPOINT'] = 'https://searx.example.com';
        expect(searxng.isAvailable()).toBe(true);
    });

    it('collectSecrets returns the configured key value for redaction', () => {
        process.env['EXA_API_KEY'] = 'secret-exa-value';
        const exa = getWebSearchProvider('exa')!;
        expect(exa.collectSecrets()).toEqual(['secret-exa-value']);
    });

    it('buildRequest produces a POST with x-api-key for exa', () => {
        process.env['EXA_API_KEY'] = 'exa-key';
        const exa = getWebSearchProvider('exa')!;
        const request = exa.buildRequest({ query: 'test', numResults: 5, recency: undefined }, 's1');
        expect(request.method).toBe('POST');
        expect(request.url).toBe('https://api.exa.ai/search');
        expect(request.headers['x-api-key']).toBe('exa-key');
        expect(request.body).toContain('"query":"test"');
    });

    it('buildRequest produces a GET with query params for brave', () => {
        process.env['BRAVE_API_KEY'] = 'brave-key';
        const brave = getWebSearchProvider('brave')!;
        const request = brave.buildRequest({ query: 'hello world', numResults: 5, recency: 'week' }, 's1');
        expect(request.method).toBe('GET');
        expect(request.url).toContain('api.search.brave.com');
        expect(request.url).toContain('q=hello+world');
        expect(request.url).toContain('freshness=pw');
        expect(request.headers['X-Subscription-Token']).toBe('brave-key');
    });

    it('parseResponse maps exa results into the WebSearchResult shape', () => {
        process.env['EXA_API_KEY'] = 'exa-key';
        const exa = getWebSearchProvider('exa')!;
        const body = JSON.stringify({
            requestId: 'r1',
            results: [
                { title: 'Test', url: 'https://test.example', summary: 'summary text', publishedDate: '2024-01-01' },
            ],
        });
        const result = exa.parseResponse(body, new Headers(), { query: 'q', numResults: 5, recency: undefined });
        expect(result.results).toHaveLength(1);
        expect(result.results[0]?.title).toBe('Test');
        expect(result.results[0]?.url).toBe('https://test.example');
        expect(result.results[0]?.content).toBe('summary text');
        expect(result.answer).toBeDefined();
    });
});
