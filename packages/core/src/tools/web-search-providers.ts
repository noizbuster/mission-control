/**
 * 14-provider web search registry (task 29 — oh-my-pi parity).
 *
 * Each provider declares its credential gate (env-based, matching the oh-my-pi
 * auth table) and a pure `buildRequest` / `parseResponse` pair. The transport
 * layer (`web-search-transport.ts`) walks the chain in
 * {@link WEB_SEARCH_PROVIDER_IDS} order, skipping providers whose credentials
 * are absent, and dispatches each candidate's request through `fetch`.
 *
 * Providers are intentionally pure data + functions: no module-level state, no
 * network calls here. This keeps them trivially unit-testable via mocked
 * `fetch` and lets the transport own the timeout/redaction boundary.
 */
import type { WebSearchInput, WebSearchProviderId, WebSearchRecency, WebSearchResult } from './web-search-schemas.js';

/** Resolved input with defaults applied (pure; no validation side effects). */
export type ResolvedSearchInput = {
    readonly query: string;
    readonly numResults: number;
    readonly recency: WebSearchRecency | undefined;
};

export type ProviderHttpRequest = {
    readonly url: string;
    readonly method: 'GET' | 'POST';
    readonly headers: Readonly<Record<string, string>>;
    readonly body: string | undefined;
};

export type ProviderSearchResult = {
    readonly results: readonly WebSearchResult[];
    readonly answer: string | undefined;
};

export interface WebSearchProvider {
    readonly id: WebSearchProviderId;
    readonly label: string;
    /** True when the credential/env gate is satisfied (auto-chain admission). */
    isAvailable(): boolean;
    /**
     * True when explicit selection should still route here even if
     * {@link isAvailable} is false. Providers with an unauthenticated fallback
     * (exa MCP, searxng public instances) override this. When omitted, the
     * chain resolver falls back to {@link isAvailable}.
     */
    readonly isExplicitlyAvailable?: () => boolean;
    /** Build the HTTP request for this provider. Pure. */
    buildRequest(input: ResolvedSearchInput, sessionId: string): ProviderHttpRequest;
    /** Parse a successful response body into results. Pure. */
    parseResponse(body: string, headers: Headers, input: ResolvedSearchInput): ProviderSearchResult;
    /** Secret values this provider consulted (for redaction). */
    collectSecrets(): readonly string[];
}

/** Read the first non-empty env value among `keys`. */
function readEnvKey(keys: readonly string[]): string | undefined {
    for (const key of keys) {
        const value = process.env[key];
        if (value !== undefined && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

/** Clamp a result count into `[1, max]`, defaulting to `def` when undefined. */
export function clampNumResults(num: number | undefined, def: number, max: number): number {
    if (num === undefined) {
        return def;
    }
    return Math.min(max, Math.max(1, Math.floor(num)));
}

/** Parse an ISO/relative date string into seconds since epoch delta. */
export function dateToAgeSeconds(dateText: string | undefined): number | undefined {
    if (dateText === undefined || dateText.length === 0) {
        return undefined;
    }
    const parsed = Date.parse(dateText);
    if (Number.isNaN(parsed)) {
        return undefined;
    }
    return Math.max(0, Math.round((Date.now() - parsed) / 1000));
}

/**
 * Raw entry before normalization. Fields may be `undefined`; `skipMissingUrl`
 * filters out entries with no url and builds clean {@link WebSearchResult}
 * objects (omitting undefined optionals so `exactOptionalPropertyTypes` holds).
 */
type RawResultEntry = {
    readonly title?: string | undefined;
    readonly url?: string | undefined;
    readonly content?: string | undefined;
    readonly snippet?: string | undefined;
    readonly score?: number | undefined;
    readonly publishedDate?: string | undefined;
};

function skipMissingUrl(entries: readonly RawResultEntry[]): readonly WebSearchResult[] {
    const out: WebSearchResult[] = [];
    for (const entry of entries) {
        const url = entry.url;
        if (url === undefined || url.length === 0) {
            continue;
        }
        const title = entry.title ?? url;
        const content = entry.content;
        const snippet = entry.snippet;
        const score = entry.score;
        const publishedDate = entry.publishedDate;
        out.push({
            title,
            url,
            ...(content !== undefined ? { content } : {}),
            ...(snippet !== undefined ? { snippet } : {}),
            ...(score !== undefined ? { score } : {}),
            ...(publishedDate !== undefined ? { publishedDate } : {}),
        });
    }
    return out;
}

function safeJsonParse(text: string): unknown {
    try {
        return JSON.parse(text);
    } catch {
        return undefined;
    }
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
        return value as Record<string, unknown>;
    }
    return undefined;
}

function asArray(value: unknown): readonly unknown[] | undefined {
    return Array.isArray(value) ? value : undefined;
}

function asString(value: unknown): string | undefined {
    return typeof value === 'string' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

// ---------------------------------------------------------------------------
// Provider definitions
// ---------------------------------------------------------------------------

function resolveInput(input: WebSearchInput): ResolvedSearchInput {
    return {
        query: input.query,
        numResults: input.numResults ?? 8,
        recency: input.recency,
    };
}

/** exa — POST https://api.exa.ai/search with `x-api-key`. */
function exaProvider(): WebSearchProvider {
    const envKeys = ['EXA_API_KEY'] as const;
    return {
        id: 'exa',
        label: 'Exa',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        isExplicitlyAvailable: () => true,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            const body = JSON.stringify({
                query: input.query,
                numResults: clampNumResults(input.numResults, 10, 50),
                type: 'auto',
                contents: { summary: { query: input.query } },
            });
            return {
                url: 'https://api.exa.ai/search',
                method: 'POST',
                headers: { 'content-type': 'application/json', 'x-api-key': key },
                body,
            };
        },
        parseResponse: (body, _headers, input) => {
            const root = asRecord(safeJsonParse(body));
            const raw = root ? asArray(root['results']) : undefined;
            const entries: RawResultEntry[] = [];
            let answer: string | undefined;
            if (raw) {
                const summaries: string[] = [];
                for (const item of raw) {
                    const rec = asRecord(item);
                    if (rec === undefined) continue;
                    const url = asString(rec['url']);
                    const summary = asString(rec['summary']);
                    const text = asString(rec['text']);
                    entries.push({
                        title: asString(rec['title']) ?? url,
                        url,
                        content: summary ?? text ?? asString(rec['highlights']),
                        snippet: summary ?? text,
                        publishedDate: asString(rec['publishedDate']),
                        score: asNumber(rec['score']),
                    });
                    if (summary !== undefined && summaries.length < 3) {
                        const title = asString(rec['title']) ?? url ?? 'Untitled';
                        summaries.push(`**${title}**: ${summary}`);
                    }
                }
                if (summaries.length > 0) {
                    answer = summaries.join('\n\n');
                }
            }
            return { results: skipMissingUrl(entries).slice(0, input.numResults), answer };
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** brave — GET https://api.search.brave.com/res/v1/web/search with `X-Subscription-Token`. */
function braveProvider(): WebSearchProvider {
    const envKeys = ['BRAVE_API_KEY'] as const;
    const freshnessMap: Record<WebSearchRecency, string> = {
        day: 'pd',
        week: 'pw',
        month: 'pm',
        year: 'py',
    };
    return {
        id: 'brave',
        label: 'Brave',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            const params = new URLSearchParams({
                q: input.query,
                count: String(clampNumResults(input.numResults, 10, 20)),
                extra_snippets: 'true',
            });
            if (input.recency !== undefined) {
                params.set('freshness', freshnessMap[input.recency]);
            }
            return {
                url: `https://api.search.brave.com/res/v1/web/search?${params.toString()}`,
                method: 'GET',
                headers: { accept: 'application/json', 'X-Subscription-Token': key },
                body: undefined,
            };
        },
        parseResponse: (body, _headers, input) => {
            const root = asRecord(safeJsonParse(body));
            const web = root ? asRecord(root['web']) : undefined;
            const raw = web ? asArray(web['results']) : undefined;
            const entries: RawResultEntry[] = [];
            if (raw) {
                for (const item of raw) {
                    const rec = asRecord(item);
                    if (rec === undefined) continue;
                    const url = asString(rec['url']);
                    const description = asString(rec['description'])?.trim();
                    const extra = asArray(rec['extra_snippets']);
                    const snippetParts: string[] = [];
                    if (description) snippetParts.push(description);
                    if (extra) {
                        const seen = new Set<string>();
                        for (const s of extra) {
                            const text = asString(s)?.trim();
                            if (text && !seen.has(text)) {
                                seen.add(text);
                                snippetParts.push(text);
                            }
                        }
                    }
                    entries.push({
                        title: asString(rec['title']) ?? url,
                        url,
                        content: snippetParts.length > 0 ? snippetParts.join('\n') : undefined,
                        snippet: snippetParts.length > 0 ? snippetParts.join('\n') : undefined,
                        publishedDate: asString(rec['age']),
                    });
                }
            }
            return { results: skipMissingUrl(entries).slice(0, input.numResults), answer: undefined };
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** jina — GET https://s.jina.ai/{query} with `Bearer`. */
function jinaProvider(): WebSearchProvider {
    const envKeys = ['JINA_API_KEY'] as const;
    return {
        id: 'jina',
        label: 'Jina',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            return {
                url: `https://s.jina.ai/${encodeURIComponent(input.query)}`,
                method: 'GET',
                headers: { accept: 'application/json', authorization: `Bearer ${key}` },
                body: undefined,
            };
        },
        parseResponse: (body, _headers, input) => {
            const root = asRecord(safeJsonParse(body));
            const raw = root ? asArray(root['data']) : undefined;
            const entries: RawResultEntry[] = [];
            if (raw) {
                for (const item of raw) {
                    const rec = asRecord(item);
                    if (rec === undefined) continue;
                    const url = asString(rec['url']);
                    entries.push({
                        title: asString(rec['title']) ?? url,
                        url,
                        content: asString(rec['content']),
                        snippet: asString(rec['content']),
                    });
                }
            }
            return {
                results: skipMissingUrl(entries).slice(0, input.numResults || undefined),
                answer: undefined,
            };
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** kimi — POST https://api.kimi.com/coding/v1/search with `Bearer`. */
function kimiProvider(): WebSearchProvider {
    const envKeys = ['MOONSHOT_SEARCH_API_KEY', 'KIMI_SEARCH_API_KEY', 'MOONSHOT_API_KEY'] as const;
    return {
        id: 'kimi',
        label: 'Kimi',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            const base =
                process.env['MOONSHOT_SEARCH_BASE_URL'] ??
                process.env['KIMI_SEARCH_BASE_URL'] ??
                'https://api.kimi.com';
            return {
                url: `${base}/coding/v1/search`,
                method: 'POST',
                headers: {
                    accept: 'application/json',
                    'content-type': 'application/json',
                    authorization: `Bearer ${key}`,
                },
                body: JSON.stringify({
                    text_query: input.query,
                    limit: clampNumResults(input.numResults, 10, 20),
                    enable_page_crawling: false,
                    timeout_seconds: 30,
                }),
            };
        },
        parseResponse: (body, _headers, input) => {
            const root = asRecord(safeJsonParse(body));
            const raw = root ? asArray(root['search_results']) : undefined;
            const entries: RawResultEntry[] = [];
            if (raw) {
                for (const item of raw) {
                    const rec = asRecord(item);
                    if (rec === undefined) continue;
                    const url = asString(rec['url']);
                    entries.push({
                        title: asString(rec['title']) ?? url,
                        url,
                        content: asString(rec['snippet']) ?? asString(rec['content']),
                        snippet: asString(rec['snippet']) ?? asString(rec['content']),
                        publishedDate: asString(rec['date']),
                    });
                }
            }
            return { results: skipMissingUrl(entries).slice(0, input.numResults), answer: undefined };
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** zai — POST JSON-RPC to the Z.AI MCP web_search_prime endpoint with `Bearer`. */
function zaiProvider(): WebSearchProvider {
    const envKeys = ['ZAI_API_KEY'] as const;
    return {
        id: 'zai',
        label: 'Z.AI',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            return {
                url: 'https://api.z.ai/api/mcp/web_search_prime/mcp',
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json, text/event-stream',
                    authorization: `Bearer ${key}`,
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: {
                        name: 'web_search_prime',
                        arguments: { query: input.query, count: clampNumResults(input.numResults, 10, 50) },
                    },
                }),
            };
        },
        parseResponse: (body, _headers, input) => {
            const root = asRecord(safeJsonParse(body));
            const raw = (root && asArray(root['search_result'])) ?? (root && asArray(root['results'])) ?? undefined;
            const entries: RawResultEntry[] = [];
            if (raw) {
                for (const item of raw) {
                    const rec = asRecord(item);
                    if (rec === undefined) continue;
                    const url = asString(rec['link']) ?? asString(rec['url']);
                    entries.push({
                        title: asString(rec['title']) ?? url,
                        url,
                        content: asString(rec['content']),
                        snippet: asString(rec['content']),
                        publishedDate: asString(rec['publish_date']) ?? asString(rec['publishedDate']),
                    });
                }
            }
            return { results: skipMissingUrl(entries).slice(0, input.numResults), answer: undefined };
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** anthropic — POST /v1/messages with the `web_search_20250305` server tool. */
function anthropicProvider(): WebSearchProvider {
    const envKeys = ['ANTHROPIC_API_KEY'] as const;
    return {
        id: 'anthropic',
        label: 'Anthropic',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            return {
                url: 'https://api.anthropic.com/v1/messages',
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    'x-api-key': key,
                    'anthropic-version': '2023-06-01',
                },
                body: JSON.stringify({
                    model: process.env['ANTHROPIC_MODEL'] ?? 'claude-sonnet-4-20250514',
                    max_tokens: 1024,
                    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }],
                    messages: [{ role: 'user', content: input.query }],
                }),
            };
        },
        parseResponse: (body, _headers, input) => {
            const root = asRecord(safeJsonParse(body));
            const content = root ? asArray(root['content']) : undefined;
            const entries: RawResultEntry[] = [];
            const textParts: string[] = [];
            if (content) {
                for (const block of content) {
                    const rec = asRecord(block);
                    if (rec === undefined) continue;
                    const type = asString(rec['type']);
                    if (type === 'web_search_tool_result') {
                        const results = asArray(rec['content']);
                        if (results) {
                            for (const r of results) {
                                const rr = asRecord(r);
                                if (rr === undefined) continue;
                                const url = asString(rr['url']);
                                entries.push({
                                    title: asString(rr['title']) ?? url,
                                    url,
                                    publishedDate: asString(rr['page_age']),
                                });
                            }
                        }
                    } else if (type === 'text') {
                        const text = asString(rec['text']);
                        if (text) textParts.push(text);
                    }
                }
            }
            return {
                results: skipMissingUrl(entries).slice(0, input.numResults),
                answer: textParts.length > 0 ? textParts.join('\n\n') : undefined,
            };
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** perplexity — POST /chat/completions (sonar) with `Bearer`. */
function perplexityProvider(): WebSearchProvider {
    const envKeys = ['PERPLEXITY_API_KEY'] as const;
    return {
        id: 'perplexity',
        label: 'Perplexity',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            const body: Record<string, unknown> = {
                model: 'sonar',
                messages: [{ role: 'user', content: input.query }],
                max_tokens: 1024,
                web_search_options: { search_context_size: 'high' },
            };
            if (input.recency !== undefined) {
                body['search_recency_filter'] = input.recency;
            }
            return {
                url: 'https://api.perplexity.ai/chat/completions',
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: JSON.stringify(body),
            };
        },
        parseResponse: (body, _headers, input) => {
            const root = asRecord(safeJsonParse(body));
            const choices = root ? asArray(root['choices']) : undefined;
            const citations = root ? asArray(root['citations']) : undefined;
            const searchResults = root ? asArray(root['search_results']) : undefined;
            const entries: RawResultEntry[] = [];
            const citeUrls = new Set<string>();
            if (citations) {
                for (const c of citations) {
                    const url = asString(c);
                    if (url) citeUrls.add(url);
                }
            }
            const byUrl = new Map<
                string,
                { title: string | undefined; snippet: string | undefined; date: string | undefined }
            >();
            if (searchResults) {
                for (const r of searchResults) {
                    const rec = asRecord(r);
                    if (rec === undefined) continue;
                    const url = asString(rec['url']);
                    if (url) {
                        byUrl.set(url, {
                            title: asString(rec['title']),
                            snippet: asString(rec['snippet']),
                            date: asString(rec['date']),
                        });
                    }
                }
            }
            const sourceUrls = citeUrls.size > 0 ? [...citeUrls] : [...byUrl.keys()];
            for (const url of sourceUrls) {
                const meta = byUrl.get(url);
                entries.push({
                    title: meta?.title ?? url,
                    url,
                    content: meta?.snippet,
                    snippet: meta?.snippet,
                    publishedDate: meta?.date,
                });
            }
            let answer: string | undefined;
            if (choices && choices.length > 0) {
                const first = asRecord(choices[0]);
                const message = first ? asRecord(first['message']) : undefined;
                answer = message ? (asString(message['content']) ?? undefined) : undefined;
            }
            return { results: skipMissingUrl(entries).slice(0, input.numResults), answer };
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** gemini — POST generateContent with the `google-search` tool. */
function geminiProvider(): WebSearchProvider {
    const envKeys = ['GEMINI_API_KEY', 'GOOGLE_API_KEY'] as const;
    return {
        id: 'gemini',
        label: 'Gemini',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            const model = process.env['GEMINI_MODEL'] ?? 'gemini-2.5-flash';
            return {
                url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(key)}`,
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({
                    contents: [{ parts: [{ text: input.query }] }],
                    tools: [{ google_search: {} }],
                }),
            };
        },
        parseResponse: (body, _headers, input) => {
            const root = asRecord(safeJsonParse(body));
            const candidates = root ? asArray(root['candidates']) : undefined;
            const entries: RawResultEntry[] = [];
            const textParts: string[] = [];
            if (candidates) {
                for (const candidate of candidates) {
                    const rec = asRecord(candidate);
                    const grounding = rec ? asRecord(rec['groundingMetadata']) : undefined;
                    const chunks = grounding ? asArray(grounding['groundingChunks']) : undefined;
                    if (chunks) {
                        for (const chunk of chunks) {
                            const cr = asRecord(chunk);
                            const web = cr ? asRecord(cr['web']) : undefined;
                            const url = web ? asString(web['uri']) : undefined;
                            if (url) {
                                entries.push({ title: web ? asString(web['title']) : url, url });
                            }
                        }
                    }
                    const content = rec ? asRecord(rec['content']) : undefined;
                    const parts = content ? asArray(content['parts']) : undefined;
                    if (parts) {
                        for (const part of parts) {
                            const pr = asRecord(part);
                            const text = pr ? asString(pr['text']) : undefined;
                            if (text) textParts.push(text);
                        }
                    }
                }
            }
            return {
                results: skipMissingUrl(entries).slice(0, input.numResults),
                answer: textParts.length > 0 ? textParts.join('\n') : undefined,
            };
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** codex — POST /v1/responses with the `web_search` tool. */
function codexProvider(): WebSearchProvider {
    const envKeys = ['OPENAI_API_KEY'] as const;
    return {
        id: 'codex',
        label: 'OpenAI',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            return {
                url: 'https://api.openai.com/v1/responses',
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: JSON.stringify({
                    model: process.env['OPENAI_MODEL'] ?? 'gpt-4o-mini',
                    tools: [{ type: 'web_search_preview' }],
                    input: input.query,
                }),
            };
        },
        parseResponse: (body, _headers, input) => {
            const root = asRecord(safeJsonParse(body));
            const output = root ? asArray(root['output']) : undefined;
            const entries: RawResultEntry[] = [];
            const textParts: string[] = [];
            if (output) {
                for (const item of output) {
                    const rec = asRecord(item);
                    if (rec === undefined) continue;
                    const type = asString(rec['type']);
                    if (type === 'web_search_call') {
                        const results = asArray(rec['results']);
                        if (results) {
                            for (const r of results) {
                                const rr = asRecord(r);
                                if (rr === undefined) continue;
                                const url = asString(rr['url']);
                                entries.push({ title: asString(rr['title']) ?? url, url });
                            }
                        }
                    } else if (type === 'message') {
                        const content = asArray(rec['content']);
                        if (content) {
                            for (const c of content) {
                                const cr = asRecord(c);
                                const text = cr ? asString(cr['text']) : undefined;
                                if (text) textParts.push(text);
                            }
                        }
                    }
                }
            }
            return {
                results: skipMissingUrl(entries).slice(0, input.numResults),
                answer: textParts.length > 0 ? textParts.join('\n') : undefined,
            };
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** tavily — POST https://api.tavily.com/search with `Bearer`. */
function tavilyProvider(): WebSearchProvider {
    const envKeys = ['TAVILY_API_KEY'] as const;
    const rangeMap: Record<WebSearchRecency, string> = {
        day: 'day',
        week: 'week',
        month: 'month',
        year: 'year',
    };
    return {
        id: 'tavily',
        label: 'Tavily',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            const body: Record<string, unknown> = {
                query: input.query,
                search_depth: 'basic',
                max_results: clampNumResults(input.numResults, 5, 20),
                include_answer: 'advanced',
                include_raw_content: false,
            };
            if (input.recency !== undefined) {
                body['time_range'] = rangeMap[input.recency];
            }
            return {
                url: 'https://api.tavily.com/search',
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: JSON.stringify(body),
            };
        },
        parseResponse: (body, _headers, input) => {
            const root = asRecord(safeJsonParse(body));
            const raw = root ? asArray(root['results']) : undefined;
            const entries: RawResultEntry[] = [];
            if (raw) {
                for (const item of raw) {
                    const rec = asRecord(item);
                    if (rec === undefined) continue;
                    const url = asString(rec['url']);
                    entries.push({
                        title: asString(rec['title']) ?? url,
                        url,
                        content: asString(rec['content']),
                        snippet: asString(rec['content']),
                        publishedDate: asString(rec['published_date']),
                    });
                }
            }
            const answer = root ? asString(root['answer']) : undefined;
            return { results: skipMissingUrl(entries).slice(0, input.numResults), answer };
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** parallel — POST https://api.parallel.ai/v1beta/search with `x-api-key`. */
function parallelProvider(): WebSearchProvider {
    const envKeys = ['PARALLEL_API_KEY'] as const;
    return {
        id: 'parallel',
        label: 'Parallel',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            return {
                url: 'https://api.parallel.ai/v1beta/search',
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json',
                    'x-api-key': key,
                    'parallel-beta': 'search-extract-2025-10-10',
                },
                body: JSON.stringify({
                    objective: input.query,
                    search_queries: [input.query],
                    mode: 'fast',
                    excerpts: { max_chars_per_result: 10000 },
                }),
            };
        },
        parseResponse: (body, _headers, input) => {
            const root = asRecord(safeJsonParse(body));
            const raw = root ? asArray(root['results']) : undefined;
            const entries: RawResultEntry[] = [];
            if (raw) {
                for (const item of raw) {
                    const rec = asRecord(item);
                    if (rec === undefined) continue;
                    const url = asString(rec['url']);
                    const excerpts = asArray(rec['excerpts']);
                    const joined =
                        excerpts !== undefined
                            ? excerpts
                                  .map((e) => asString(e) ?? '')
                                  .filter((s) => s.length > 0)
                                  .join('\n\n')
                            : undefined;
                    entries.push({
                        title: asString(rec['title']) ?? url,
                        url,
                        content: joined,
                        snippet: joined,
                        publishedDate: asString(rec['publish_date']),
                    });
                }
            }
            return { results: skipMissingUrl(entries).slice(0, input.numResults), answer: undefined };
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** kagi — POST https://kagi.com/api/v1/search with `Bearer`. */
function kagiProvider(): WebSearchProvider {
    const envKeys = ['KAGI_API_KEY'] as const;
    return {
        id: 'kagi',
        label: 'Kagi',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            const body: Record<string, unknown> = {
                query: input.query,
                workflow: 'search',
                limit: clampNumResults(input.numResults, 10, 40),
            };
            if (input.recency !== undefined) {
                body['filters'] = { after: kagiAfterDate(input.recency) };
            }
            return {
                url: 'https://kagi.com/api/v1/search',
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'application/json',
                    authorization: `Bearer ${key}`,
                },
                body: JSON.stringify(body),
            };
        },
        parseResponse: (body, _headers, input) => {
            const root = asRecord(safeJsonParse(body));
            const data = root ? asRecord(root['data']) : undefined;
            const entries: RawResultEntry[] = [];
            let answer: string | undefined;
            if (data) {
                for (const bucket of ['search', 'news', 'video', 'infobox'] as const) {
                    const arr = asArray(data[bucket]);
                    const prefix =
                        bucket === 'news'
                            ? '[News] '
                            : bucket === 'video'
                              ? '[Video] '
                              : bucket === 'infobox'
                                ? '[Info] '
                                : '';
                    if (arr) {
                        for (const item of arr) {
                            const rec = asRecord(item);
                            if (rec === undefined) continue;
                            const url = asString(rec['url']);
                            entries.push({
                                title: prefix + (asString(rec['title']) ?? url ?? ''),
                                url,
                                content: asString(rec['snippet']),
                                snippet: asString(rec['snippet']),
                                publishedDate: asString(rec['time']),
                            });
                        }
                    }
                }
                const directAnswer = asArray(data['direct_answer']);
                if (directAnswer && directAnswer.length > 0) {
                    const rec = asRecord(directAnswer[0]);
                    answer = rec ? (asString(rec['snippet']) ?? asString(rec['title'])) : undefined;
                }
            }
            return { results: skipMissingUrl(entries).slice(0, input.numResults), answer };
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

function kagiAfterDate(recency: WebSearchRecency): string {
    const now = new Date();
    const d = new Date(
        Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth() - (recency === 'year' ? 12 : recency === 'month' ? 1 : 0),
            now.getUTCDate() - (recency === 'day' ? 1 : recency === 'week' ? 7 : 0),
        ),
    );
    return d.toISOString().slice(0, 10);
}

/** synthetic — POST https://api.synthetic.new/v2/search with `Bearer`. */
function syntheticProvider(): WebSearchProvider {
    const envKeys = ['SYNTHETIC_API_KEY'] as const;
    return {
        id: 'synthetic',
        label: 'Synthetic',
        isAvailable: () => readEnvKey(envKeys) !== undefined,
        buildRequest: (input) => {
            const key = readEnvKey(envKeys) ?? '';
            return {
                url: 'https://api.synthetic.new/v2/search',
                method: 'POST',
                headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
                body: JSON.stringify({ query: input.query }),
            };
        },
        parseResponse: (body, _headers, input) => {
            const root = asRecord(safeJsonParse(body));
            const raw = root ? asArray(root['results']) : undefined;
            const entries: RawResultEntry[] = [];
            if (raw) {
                for (const item of raw) {
                    const rec = asRecord(item);
                    if (rec === undefined) continue;
                    const url = asString(rec['url']);
                    entries.push({
                        title: asString(rec['title']) ?? url,
                        url,
                        content: asString(rec['text']),
                        snippet: asString(rec['text']),
                        publishedDate: asString(rec['published']),
                    });
                }
            }
            return { results: skipMissingUrl(entries).slice(0, input.numResults), answer: undefined };
        },
        collectSecrets: () => {
            const v = readEnvKey(envKeys);
            return v !== undefined ? [v] : [];
        },
    };
}

/** searxng — GET <endpoint>/search?format=json (self-hosted; optional basic/bearer). */
function searxngProvider(): WebSearchProvider {
    const endpointKeys = ['SEARXNG_ENDPOINT'] as const;
    const timeRangeMap: Record<WebSearchRecency, string> = {
        day: 'day',
        week: 'month',
        month: 'month',
        year: 'year',
    };
    return {
        id: 'searxng',
        label: 'SearXNG',
        isAvailable: () => readEnvKey(endpointKeys) !== undefined,
        isExplicitlyAvailable: () => readEnvKey(endpointKeys) !== undefined,
        buildRequest: (input) => {
            const endpoint = (readEnvKey(endpointKeys) ?? '').replace(/\/+$/, '');
            const params = new URLSearchParams({ q: input.query, format: 'json', pageno: '1' });
            if (input.recency !== undefined) {
                params.set('time_range', timeRangeMap[input.recency]);
            }
            const headers: Record<string, string> = { accept: 'application/json' };
            const token = process.env['SEARXNG_TOKEN'];
            if (token) {
                headers['authorization'] = `Bearer ${token}`;
            }
            const basicUser = process.env['SEARXNG_BASIC_USERNAME'];
            const basicPass = process.env['SEARXNG_BASIC_PASSWORD'];
            if (basicUser !== undefined && basicPass !== undefined) {
                headers['authorization'] = `Basic ${Buffer.from(`${basicUser}:${basicPass}`).toString('base64')}`;
            }
            return { url: `${endpoint}/search?${params.toString()}`, method: 'GET', headers, body: undefined };
        },
        parseResponse: (body, _headers, input) => {
            const root = asRecord(safeJsonParse(body));
            const raw = root ? asArray(root['results']) : undefined;
            const entries: RawResultEntry[] = [];
            if (raw) {
                for (const item of raw) {
                    const rec = asRecord(item);
                    if (rec === undefined) continue;
                    const url = asString(rec['url']);
                    const content = asString(rec['content'])?.trim();
                    entries.push({
                        title: asString(rec['title']) ?? url,
                        url,
                        content: content && content.length > 0 ? content : undefined,
                        snippet: content && content.length > 0 ? content : undefined,
                        publishedDate: asString(rec['publishedDate']) ?? asString(rec['published_date']),
                    });
                }
            }
            return {
                results: skipMissingUrl(entries).slice(0, clampNumResults(input.numResults, 10, 20)),
                answer: undefined,
            };
        },
        collectSecrets: () => {
            const secrets: string[] = [];
            const token = process.env['SEARXNG_TOKEN'];
            if (token) secrets.push(token);
            const basicPass = process.env['SEARXNG_BASIC_PASSWORD'];
            if (basicPass) secrets.push(basicPass);
            return secrets;
        },
    };
}

// ---------------------------------------------------------------------------
// Registry + chain resolver
// ---------------------------------------------------------------------------

function buildProviderRegistry(): readonly WebSearchProvider[] {
    return [
        exaProvider(),
        braveProvider(),
        jinaProvider(),
        kimiProvider(),
        zaiProvider(),
        anthropicProvider(),
        perplexityProvider(),
        geminiProvider(),
        codexProvider(),
        tavilyProvider(),
        parallelProvider(),
        kagiProvider(),
        syntheticProvider(),
        searxngProvider(),
    ];
}

const PROVIDERS: readonly WebSearchProvider[] = buildProviderRegistry();

export function getWebSearchProvider(id: WebSearchProviderId): WebSearchProvider | undefined {
    return PROVIDERS.find((provider) => provider.id === id);
}

export function allWebSearchProviders(): readonly WebSearchProvider[] {
    return PROVIDERS;
}

/**
 * Resolve the provider chain. When `preference` is a concrete id, that provider
 * is tried first (if explicitly available); then the rest of the chain in
 * {@link WEB_SEARCH_PROVIDER_IDS} order (only those currently available). For
 * `auto`, the whole available chain is returned in order.
 */
export function resolveProviderChain(preference: WebSearchProviderId | 'auto' = 'auto'): readonly WebSearchProvider[] {
    const chain: WebSearchProvider[] = [];
    if (preference !== 'auto') {
        const pinned = getWebSearchProvider(preference);
        if (pinned !== undefined && (pinned.isExplicitlyAvailable?.() ?? pinned.isAvailable())) {
            chain.push(pinned);
        }
    }
    for (const provider of PROVIDERS) {
        if (provider.id === preference) continue;
        if (provider.isAvailable()) {
            chain.push(provider);
        }
    }
    return chain;
}

export { resolveInput };
