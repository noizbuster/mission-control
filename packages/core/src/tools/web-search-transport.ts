import { z } from 'zod';
import type { WebSearchInput, WebSearchOutput, WebSearchResult } from './web-search-schemas.js';

/**
 * `web_search` MCP-over-HTTP transport (Wave 2, task 4).
 *
 * Sends JSON-RPC 2.0 `tools/call` POSTs to Exa or Parallel search providers,
 * then parses the MCP content envelope (direct JSON or SSE `data:` lines) into
 * structured `WebSearchResult[]`. Ported from opencode's Effect-based
 * `mcp-websearch.ts` to plain async/await with a 25s `AbortController` timeout.
 */

const EXA_BASE_URL = 'https://mcp.exa.ai/mcp';
const PARALLEL_URL = 'https://search.parallel.ai/mcp';
const WEB_SEARCH_TIMEOUT_MS = 25_000;

export type WebSearchProviderId = 'exa' | 'parallel';

export type WebSearchTransportOptions = {
    readonly provider: WebSearchProviderId;
    readonly sessionId: string;
};

export function selectWebSearchProvider(): WebSearchProviderId | undefined {
    if (process.env['EXA_API_KEY']) return 'exa';
    if (process.env['PARALLEL_API_KEY']) return 'parallel';
    return undefined;
}

type ProviderCallConfig = {
    readonly url: string;
    readonly toolName: string;
    readonly arguments: Readonly<Record<string, unknown>>;
    readonly headers: Readonly<Record<string, string>>;
};

export async function executeWebSearch(
    input: WebSearchInput,
    options: WebSearchTransportOptions,
): Promise<WebSearchOutput> {
    const config = buildProviderCallConfig(options.provider, input, options.sessionId);
    const requestBody = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: config.toolName, arguments: config.arguments },
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
    try {
        const response = await fetch(config.url, {
            method: 'POST',
            headers: {
                accept: 'application/json, text/event-stream',
                'content-type': 'application/json',
                ...config.headers,
            },
            body: requestBody,
            signal: controller.signal,
        });
        if (!response.ok) {
            throw new Error(`web_search ${options.provider} request returned HTTP ${response.status}`);
        }
        const body = await response.text();
        const payload = parseMcpResponse(body);
        if (payload === undefined) {
            return { results: [], provider: options.provider };
        }
        return { results: parseSearchResults(payload), provider: options.provider };
    } catch (error) {
        if (controller.signal.aborted) {
            throw new Error(`web_search ${options.provider} request timed out after ${WEB_SEARCH_TIMEOUT_MS / 1000}s`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function buildProviderCallConfig(
    provider: WebSearchProviderId,
    input: WebSearchInput,
    sessionId: string,
): ProviderCallConfig {
    if (provider === 'exa') {
        const apiKey = process.env['EXA_API_KEY'];
        const url = apiKey !== undefined ? `${EXA_BASE_URL}?exaApiKey=${encodeURIComponent(apiKey)}` : EXA_BASE_URL;
        const args = {
            query: input.query,
            type: input.type ?? 'auto',
            numResults: input.numResults ?? 8,
            livecrawl: 'fallback',
            ...(input.contextMaxCharacters !== undefined ? { contextMaxCharacters: input.contextMaxCharacters } : {}),
        };
        return { url, toolName: 'web_search_exa', arguments: args, headers: {} };
    }
    const headers: Record<string, string> = {};
    const parallelKey = process.env['PARALLEL_API_KEY'];
    if (parallelKey !== undefined) {
        headers['Authorization'] = `Bearer ${parallelKey}`;
    }
    const args = {
        objective: input.query,
        search_queries: [input.query],
        session_id: sessionId,
        model_name: 'auto',
    };
    return { url: PARALLEL_URL, toolName: 'web_search', arguments: args, headers };
}

const mcpEnvelopeSchema = z.object({
    result: z.object({
        content: z
            .array(
                z.object({
                    type: z.string().optional(),
                    text: z.string().optional(),
                }),
            )
            .min(1),
    }),
});

const rawResultSchema = z.object({
    title: z.string().default(''),
    url: z.string().default(''),
    content: z.string().optional(),
    text: z.string().optional(),
    score: z.number().optional(),
});

const arrayContainerSchema = z.object({
    results: z.array(z.unknown()).optional(),
    data: z.array(z.unknown()).optional(),
});

function extractTextFromPayload(payload: string): string | undefined {
    const trimmed = payload.trim();
    if (!trimmed.startsWith('{')) return undefined;
    const json = safeJsonParse(trimmed);
    if (json === undefined) return undefined;
    const parsed = mcpEnvelopeSchema.safeParse(json);
    if (!parsed.success) return undefined;
    for (const item of parsed.data.result.content) {
        if (item.text !== undefined && item.text.length > 0) {
            return item.text;
        }
    }
    return undefined;
}

function parseMcpResponse(body: string): string | undefined {
    const trimmed = body.trim();
    const direct = trimmed.length > 0 ? extractTextFromPayload(trimmed) : undefined;
    if (direct !== undefined) return direct;
    for (const line of body.split('\n')) {
        if (!line.startsWith('data: ')) continue;
        const text = extractTextFromPayload(line.substring('data: '.length));
        if (text !== undefined) return text;
    }
    return undefined;
}

function parseSearchResults(text: string): WebSearchResult[] {
    const trimmed = text.trim();
    if (trimmed.length === 0) return [];
    const json = safeJsonParse(trimmed);
    if (json === undefined) {
        return [{ title: '', url: '', content: trimmed }];
    }
    const rawArray: readonly unknown[] | undefined = Array.isArray(json) ? json : extractArrayField(json);
    if (rawArray === undefined) {
        return [{ title: '', url: '', content: trimmed }];
    }
    const results: WebSearchResult[] = [];
    for (const entry of rawArray) {
        const parsed = rawResultSchema.safeParse(entry);
        if (!parsed.success) continue;
        const data = parsed.data;
        const content = data.content ?? data.text;
        results.push({
            title: data.title,
            url: data.url,
            ...(content !== undefined ? { content } : {}),
            ...(data.score !== undefined ? { score: data.score } : {}),
        });
    }
    return results;
}

function extractArrayField(value: unknown): readonly unknown[] | undefined {
    const parsed = arrayContainerSchema.safeParse(value);
    if (!parsed.success) return undefined;
    return parsed.data.results ?? parsed.data.data;
}

function safeJsonParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}
