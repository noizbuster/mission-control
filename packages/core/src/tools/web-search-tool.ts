/**
 * `web_search` tool registration (Wave 2, task 5; expanded task 29 to the
 * 14-provider chain + site-aware extraction).
 *
 * Wraps the chain transport from `web-search-transport.ts` behind the
 * `ToolRegistration` surface. When `input.extract` is set, the top result URLs
 * are run through `extractSiteContent` (site-aware handlers + N-API
 * `htmlToMarkdown`) and the structured markdown is attached to each result.
 * The NativesClient is injectable so graph-path and noninteractive runs get
 * HTML→Markdown conversion when the addon is present. The tool stays
 * `['network']` capability and self-gates via the credential-gated chain: no
 * provider configured → a helpful `ToolExecutionError`.
 */
import type { z } from 'zod';
import { type NativesClient } from '../native/natives-client';
import { type ToolAdvertisement, ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry';
import { extractSiteContent } from './web-search-extraction';
import {
    type WebSearchInput,
    type WebSearchOutput,
    type WebSearchResult,
    webSearchInputSchema,
    webSearchOutputSchema,
    webSearchParametersJsonSchema,
} from './web-search-schemas';
import { executeWebSearch, noProviderMessage } from './web-search-transport';

export type WebSearchToolOptions = {
    readonly sessionId: string;
    /** Optional native client for site-aware HTML→Markdown extraction. */
    readonly natives?: NativesClient;
};

export async function registerWebSearchTool(
    registry: ToolRegistry,
    options: WebSearchToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(createWebSearchToolRegistration(options));
}

export function createWebSearchToolRegistration(
    options: WebSearchToolOptions,
): ToolRegistration<WebSearchInput, WebSearchOutput> {
    return {
        name: 'web_search',
        description:
            'Search the web for real-time information. Returns relevant results with titles, URLs, and content snippets.',
        capabilityClasses: ['network'],
        parametersJsonSchema: webSearchParametersJsonSchema(),
        // exactOptionalPropertyTypes: hand-written types omit `| undefined` on optional fields; Zod infers it.
        inputSchema: webSearchInputSchema as z.ZodType<WebSearchInput>,
        outputSchema: webSearchOutputSchema as z.ZodType<WebSearchOutput>,
        outputLimit: { maxModelOutputChars: 10_000 },
        execute: (input, context) => runWebSearch(input, options, context.signal),
        toModelOutput: webSearchModelOutput,
        guideline:
            'Use web_search when you need current information that may not be in the workspace. Pair with webfetch to read full page content.',
    };
}

async function runWebSearch(
    input: WebSearchInput,
    options: WebSearchToolOptions,
    signal: AbortSignal,
): Promise<WebSearchOutput> {
    try {
        const output = await executeWebSearch(input, { sessionId: options.sessionId });
        if (input.extract === true && output.results.length > 0) {
            return await attachExtraction(output, options.natives, signal);
        }
        return output;
    } catch (error: unknown) {
        if (error instanceof ToolExecutionError) {
            throw error;
        }
        const message = error instanceof Error ? error.message : String(error);
        if (message.startsWith('No web search provider configured') || message === noProviderMessage()) {
            throw new ToolExecutionError({
                code: 'tool_failed',
                message,
                retryable: false,
            });
        }
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: `web_search failed: ${message}`,
            retryable: true,
        });
    }
}

async function attachExtraction(
    output: WebSearchOutput,
    natives: NativesClient | undefined,
    signal: AbortSignal,
): Promise<WebSearchOutput> {
    const top = output.results.slice(0, 3);
    const enriched = await Promise.all(
        top.map(async (result) => {
            const extracted = await extractSiteContent(result.url, natives, signal);
            if (extracted === undefined) {
                return result;
            }
            return { ...result, extracted: extracted.markdown };
        }),
    );
    const enrichedByUrl = new Map(enriched.map((r) => [r.url, r]));
    const merged = output.results.map((r) => enrichedByUrl.get(r.url) ?? r);
    return { ...output, results: merged };
}

function webSearchModelOutput(output: WebSearchOutput): string {
    const header = `web_search results (provider: ${output.provider})`;
    const parts: string[] = [header];
    if (output.answer !== undefined && output.answer.length > 0) {
        parts.push('', '## Answer', output.answer);
    }
    if (output.results.length === 0) {
        parts.push('No results found.');
        return parts.join('\n');
    }
    parts.push('', '## Sources');
    const blocks = output.results.map((result, index) => formatResult(result, index));
    return `${parts.join('\n')}\n\n${blocks.join('\n\n')}`;
}

function formatResult(result: WebSearchResult, index: number): string {
    const lines = [`[${index + 1}] ${result.title}`, `URL: ${result.url}`];
    if (result.publishedDate !== undefined && result.publishedDate.length > 0) {
        lines.push(`Published: ${result.publishedDate}`);
    }
    const content = result.extracted ?? result.content ?? result.snippet;
    if (content !== undefined && content.length > 0) {
        lines.push(`Content: ${content}`);
    }
    return lines.join('\n');
}
