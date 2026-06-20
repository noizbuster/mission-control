/**
 * `web_search` tool registration (Wave 2, task 5).
 *
 * Wraps the MCP-over-HTTP transport from `web-search-transport.ts` behind the
 * `ToolRegistration` surface. Provider selection is deferred to call time
 * (`selectWebSearchProvider`) so the tool can be registered once and adapt to
 * env changes. Transport errors surface as `retryable: true` ToolExecutionError
 * so the provider loop can re-attempt on transient network failures.
 */
import type { z } from 'zod';
import { type ToolAdvertisement, ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry.js';
import {
    type WebSearchInput,
    type WebSearchOutput,
    type WebSearchResult,
    webSearchInputSchema,
    webSearchOutputSchema,
    webSearchParametersJsonSchema,
} from './web-search-schemas.js';
import { executeWebSearch, selectWebSearchProvider } from './web-search-transport.js';

export type WebSearchToolOptions = {
    readonly sessionId: string;
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
        execute: (input) => runWebSearch(input, options),
        toModelOutput: webSearchModelOutput,
        guideline:
            'Use web_search when you need current information that may not be in the workspace. Pair with webfetch to read full page content.',
    };
}

async function runWebSearch(input: WebSearchInput, options: WebSearchToolOptions): Promise<WebSearchOutput> {
    const provider = selectWebSearchProvider();
    if (provider === undefined) {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: 'No web search provider configured. Set EXA_API_KEY or PARALLEL_API_KEY.',
            retryable: false,
        });
    }
    try {
        return await executeWebSearch(input, { provider, sessionId: options.sessionId });
    } catch (error: unknown) {
        if (error instanceof ToolExecutionError) {
            throw error;
        }
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: `web_search failed: ${errorMessage(error)}`,
            retryable: true,
        });
    }
}

function webSearchModelOutput(output: WebSearchOutput): string {
    const header = `web_search results (provider: ${output.provider})`;
    if (output.results.length === 0) {
        return `${header}\nNo results found.`;
    }
    const blocks = output.results.map((result, index) => formatResult(result, index));
    return `${header}\n\n${blocks.join('\n\n')}`;
}

function formatResult(result: WebSearchResult, index: number): string {
    const lines = [`[${index + 1}] ${result.title}`, `URL: ${result.url}`];
    if (result.content !== undefined && result.content.length > 0) {
        lines.push(`Content: ${result.content}`);
    }
    return lines.join('\n');
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
