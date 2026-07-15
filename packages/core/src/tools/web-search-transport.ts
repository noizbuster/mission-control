/**
 * `web_search` chain orchestration transport (task 29 — 14-provider parity).
 *
 * Walks the resolved provider chain, dispatches each candidate's HTTP request
 * through `fetch` with a bounded timeout, and parses the response via the
 * provider's `parseResponse`. Failures fall through to the next provider; only
 * user-initiated aborts surface immediately. All secret values consulted by
 * attempted providers are collected and redacted from the final output so no
 * API key ever leaks into results, answers, or error messages.
 */
import { createSecretRedactor } from './mcp/secret-redaction';
import {
    allWebSearchProviders,
    resolveInput,
    resolveProviderChain,
    type WebSearchProvider,
} from './web-search-providers';
import type {
    WebSearchInput,
    WebSearchOutput,
    WebSearchProviderId,
    WebSearchProviderPreference,
    WebSearchResult,
} from './web-search-schemas';

export type { WebSearchProviderId } from './web-search-schemas';

const WEB_SEARCH_TIMEOUT_MS = 25_000;

export type WebSearchTransportOptions = {
    readonly provider?: WebSearchProviderPreference;
    readonly sessionId: string;
};

/**
 * Legacy single-provider selector kept for backward compatibility with
 * callers that only care about the original exa/parallel pair. Returns the
 * first available of that pair, or `undefined` when neither is configured.
 */
export function selectWebSearchProvider(): WebSearchProviderId | undefined {
    if (process.env['EXA_API_KEY']) return 'exa';
    if (process.env['PARALLEL_API_KEY']) return 'parallel';
    return undefined;
}

export async function executeWebSearch(
    input: WebSearchInput,
    options: WebSearchTransportOptions,
): Promise<WebSearchOutput> {
    const preference: WebSearchProviderPreference = options.provider ?? input.provider ?? 'auto';
    const resolvedInput = resolveInput(input);
    const chain = resolveProviderChain(preference);

    if (chain.length === 0) {
        throw new Error(noProviderMessage());
    }

    const secrets = new Set<string>();
    const failures: Array<{ provider: WebSearchProvider; error: unknown }> = [];
    let lastProvider = chain[0]!;

    for (const provider of chain) {
        lastProvider = provider;
        for (const secret of provider.collectSecrets()) {
            if (secret.length > 0) secrets.add(secret);
        }
        try {
            const result = await dispatchProvider(provider, resolvedInput, options.sessionId);
            return redactOutput(
                {
                    results: result.results,
                    provider: provider.id,
                    ...(result.answer !== undefined ? { answer: result.answer } : {}),
                },
                secrets,
            );
        } catch (error: unknown) {
            if (isAbortError(error)) {
                throw error;
            }
            failures.push({ provider, error });
        }
    }

    const message =
        failures.length > 0
            ? `All configured web search providers failed: ${failures
                  .map((f) => `${f.provider.id}: ${errorMessage(f.error)}`)
                  .join('; ')}`
            : noProviderMessage();
    throw new Error(redactText(message, secrets));
}

async function dispatchProvider(
    provider: WebSearchProvider,
    input: ReturnType<typeof resolveInput>,
    sessionId: string,
): Promise<{ results: readonly WebSearchResult[]; answer: string | undefined }> {
    const request = provider.buildRequest(input, sessionId);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEB_SEARCH_TIMEOUT_MS);
    try {
        const response = await fetch(request.url, {
            method: request.method,
            headers: { accept: 'application/json, text/event-stream', ...request.headers },
            ...(request.body !== undefined ? { body: request.body } : {}),
            signal: controller.signal,
        });
        if (!response.ok) {
            const bodyText = await safeReadText(response);
            throw new Error(
                `${provider.id} returned HTTP ${response.status}${bodyText.length > 0 ? `: ${bodyText.slice(0, 200)}` : ''}`,
            );
        }
        const body = await response.text();
        const parsed = provider.parseResponse(body, response.headers, input);
        if (parsed.results.length === 0 && parsed.answer === undefined) {
            throw new Error(`${provider.id} returned no results`);
        }
        return parsed;
    } catch (error: unknown) {
        if (controller.signal.aborted) {
            throw new Error(`${provider.id} request timed out after ${WEB_SEARCH_TIMEOUT_MS / 1000}s`);
        }
        throw error;
    } finally {
        clearTimeout(timer);
    }
}

function redactOutput(output: WebSearchOutput, secrets: Set<string>): WebSearchOutput {
    if (secrets.size === 0) {
        return output;
    }
    const redactor = createSecretRedactor([...secrets]);
    const redactedResults = output.results.map((result) => ({
        title: redactor.redactText(result.title),
        url: result.url,
        ...(result.content !== undefined ? { content: redactor.redactText(result.content) } : {}),
        ...(result.snippet !== undefined ? { snippet: redactor.redactText(result.snippet) } : {}),
        ...(result.score !== undefined ? { score: result.score } : {}),
        ...(result.publishedDate !== undefined ? { publishedDate: redactor.redactText(result.publishedDate) } : {}),
        ...(result.extracted !== undefined ? { extracted: redactor.redactText(result.extracted) } : {}),
    }));
    return {
        results: redactedResults,
        provider: output.provider,
        ...(output.answer !== undefined ? { answer: redactor.redactText(output.answer) } : {}),
    };
}

function redactText(text: string, secrets: Set<string>): string {
    if (secrets.size === 0) {
        return text;
    }
    return createSecretRedactor([...secrets]).redactText(text);
}

function isAbortError(error: unknown): boolean {
    if (error instanceof Error) {
        return error.name === 'AbortError' || /aborted/i.test(error.message);
    }
    return false;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

async function safeReadText(response: Response): Promise<string> {
    try {
        return await response.text();
    } catch {
        return '';
    }
}

/** Human-readable message listing the credential env vars checked. */
export function noProviderMessage(): string {
    const envs = allWebSearchProviders()
        .map((provider) => providerCredentialHint(provider.id))
        .filter((hint): hint is string => hint !== undefined);
    return `No web search provider configured. Set one of: ${envs.join(', ')}.`;
}

function providerCredentialHint(id: WebSearchProviderId): string | undefined {
    switch (id) {
        case 'exa':
            return 'EXA_API_KEY';
        case 'brave':
            return 'BRAVE_API_KEY';
        case 'jina':
            return 'JINA_API_KEY';
        case 'kimi':
            return 'MOONSHOT_SEARCH_API_KEY (or KIMI_SEARCH_API_KEY / MOONSHOT_API_KEY)';
        case 'zai':
            return 'ZAI_API_KEY';
        case 'anthropic':
            return 'ANTHROPIC_API_KEY';
        case 'perplexity':
            return 'PERPLEXITY_API_KEY';
        case 'gemini':
            return 'GEMINI_API_KEY (or GOOGLE_API_KEY)';
        case 'codex':
            return 'OPENAI_API_KEY';
        case 'tavily':
            return 'TAVILY_API_KEY';
        case 'parallel':
            return 'PARALLEL_API_KEY';
        case 'kagi':
            return 'KAGI_API_KEY';
        case 'synthetic':
            return 'SYNTHETIC_API_KEY';
        case 'searxng':
            return 'SEARXNG_ENDPOINT';
        default:
            return undefined;
    }
}
