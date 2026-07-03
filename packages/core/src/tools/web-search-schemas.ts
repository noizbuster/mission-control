import { z } from 'zod';

/**
 * `web_search` tool schemas (Wave 2, task 4; expanded task 29 to the 14-provider chain).
 *
 * Input + output contracts plus a model-facing JSON Schema. The transport in
 * `web-search-transport.ts` dispatches to the resolved provider in
 * `web-search-providers.ts` and parses each provider's response envelope into
 * the unified {@link WebSearchResult} shape. Site-aware extraction
 * (`web-search-extraction.ts`) can attach structured markdown to individual
 * results via the optional `extracted` field.
 */

/**
 * The fourteen provider backends, in `auto`-chain order. Derived from the
 * oh-my-pi `SEARCH_PROVIDER_ORDER` so the auto chain walks the same priority.
 * `auto` itself is not a provider id; it selects the first available provider.
 */
export const WEB_SEARCH_PROVIDER_IDS = [
    'exa',
    'brave',
    'jina',
    'kimi',
    'zai',
    'anthropic',
    'perplexity',
    'gemini',
    'codex',
    'tavily',
    'parallel',
    'kagi',
    'synthetic',
    'searxng',
] as const;

export type WebSearchProviderId = (typeof WEB_SEARCH_PROVIDER_IDS)[number];

/** Provider preference: any concrete id or `auto` (chain). */
export const WEB_SEARCH_PROVIDER_PREFERENCE = ['auto', ...WEB_SEARCH_PROVIDER_IDS] as const;
export type WebSearchProviderPreference = (typeof WEB_SEARCH_PROVIDER_PREFERENCE)[number];

export function isWebSearchProviderId(value: string): value is WebSearchProviderId {
    return (WEB_SEARCH_PROVIDER_IDS as readonly string[]).includes(value);
}

export function isWebSearchProviderPreference(value: string): value is WebSearchProviderPreference {
    return (WEB_SEARCH_PROVIDER_PREFERENCE as readonly string[]).includes(value);
}

export const WEB_SEARCH_RECENCY_VALUES = ['day', 'week', 'month', 'year'] as const;
export type WebSearchRecency = (typeof WEB_SEARCH_RECENCY_VALUES)[number];

export const webSearchInputSchema = z
    .object({
        query: z.string().min(1),
        numResults: z.number().int().positive().optional(),
        type: z.enum(['auto', 'fast', 'deep']).optional(),
        contextMaxCharacters: z.number().int().positive().optional(),
        /** Pin a provider by id, or `auto` to walk the credential-gated chain. */
        provider: z.enum(WEB_SEARCH_PROVIDER_PREFERENCE).optional(),
        /** Temporal filter forwarded to providers that support it. */
        recency: z.enum(WEB_SEARCH_RECENCY_VALUES).optional(),
        /** When true, fetch + convert the top result URLs to structured markdown. */
        extract: z.boolean().optional(),
    })
    .strict();

export type WebSearchInput = {
    readonly query: string;
    readonly numResults?: number;
    readonly type?: 'auto' | 'fast' | 'deep';
    readonly contextMaxCharacters?: number;
    readonly provider?: WebSearchProviderPreference;
    readonly recency?: WebSearchRecency;
    readonly extract?: boolean;
};

export const webSearchResultSchema = z
    .object({
        title: z.string(),
        url: z.string(),
        content: z.string().optional(),
        snippet: z.string().optional(),
        score: z.number().optional(),
        publishedDate: z.string().optional(),
        /** Structured markdown extracted from the result URL (site-aware). */
        extracted: z.string().optional(),
    })
    .strict();

export type WebSearchResult = {
    readonly title: string;
    readonly url: string;
    readonly content?: string;
    readonly snippet?: string;
    readonly score?: number;
    readonly publishedDate?: string;
    readonly extracted?: string;
};

export const webSearchOutputSchema = z
    .object({
        results: z.array(webSearchResultSchema),
        provider: z.string(),
        answer: z.string().optional(),
    })
    .strict();

export type WebSearchOutput = {
    readonly results: readonly WebSearchResult[];
    readonly provider: string;
    readonly answer?: string;
};

export function webSearchParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            query: { type: 'string', description: 'Natural language web search query.' },
            numResults: {
                type: 'integer',
                minimum: 1,
                description: 'Number of results to return (default 8).',
            },
            type: {
                type: 'string',
                enum: ['auto', 'fast', 'deep'],
                description: "'auto' balanced (default), 'fast' quick results, 'deep' comprehensive search.",
            },
            contextMaxCharacters: {
                type: 'integer',
                minimum: 1,
                description: 'Max characters of content per result (default 10000).',
            },
            provider: {
                type: 'string',
                enum: [...WEB_SEARCH_PROVIDER_PREFERENCE],
                description:
                    "Search backend. 'auto' (default) walks the credential-gated chain; pin a provider by id to bypass the chain.",
            },
            recency: {
                type: 'string',
                enum: [...WEB_SEARCH_RECENCY_VALUES],
                description: 'Temporal filter: day, week, month, or year.',
            },
            extract: {
                type: 'boolean',
                description: 'When true, fetch the top result URLs and attach structured markdown.',
            },
        },
        required: ['query'],
        additionalProperties: false,
    };
}
