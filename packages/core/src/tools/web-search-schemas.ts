import { z } from 'zod';

/**
 * `web_search` tool schemas (Wave 2, task 4).
 *
 * Input + output contracts plus a model-facing JSON Schema. The transport in
 * `web-search-transport.ts` sends these as JSON-RPC `tools/call` arguments to
 * Exa or Parallel and parses the returned MCP content envelope.
 */

export const webSearchInputSchema = z
    .object({
        query: z.string().min(1),
        numResults: z.number().int().positive().optional(),
        type: z.enum(['auto', 'fast', 'deep']).optional(),
        contextMaxCharacters: z.number().int().positive().optional(),
    })
    .strict();

export type WebSearchInput = {
    readonly query: string;
    readonly numResults?: number;
    readonly type?: 'auto' | 'fast' | 'deep';
    readonly contextMaxCharacters?: number;
};

export const webSearchResultSchema = z
    .object({
        title: z.string(),
        url: z.string(),
        content: z.string().optional(),
        score: z.number().optional(),
    })
    .strict();

export type WebSearchResult = {
    readonly title: string;
    readonly url: string;
    readonly content?: string;
    readonly score?: number;
};

export const webSearchOutputSchema = z
    .object({
        results: z.array(webSearchResultSchema),
        provider: z.string(),
    })
    .strict();

export type WebSearchOutput = {
    readonly results: readonly WebSearchResult[];
    readonly provider: string;
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
        },
        required: ['query'],
        additionalProperties: false,
    };
}
