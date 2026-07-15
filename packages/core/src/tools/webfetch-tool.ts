/**
 * `webfetch` tool — fetch a URL and return its body (opencode/pi surface, Phase 4).
 *
 * Uses the runtime `fetch`. Body is returned as text and truncated with a continuation hint.
 * Errors (non-2xx, network) surface as a `ToolExecutionError` so the model can read + adjust.
 *
 * When an internal scheme resolver is injected, URLs carrying a registered
 * internal scheme (`pr://`, `agent://`, ...) short-circuit to the resolver
 * instead of hitting the network.
 */
import { z } from 'zod';
import type { NativesClient } from '../native/natives-client';
import type { SchemeResolver } from './scheme-resolver';
import { interceptWebfetch } from './scheme-resolver';
import type { ToolRegistration } from './tool-registry-types';
import { ToolExecutionError } from './tool-registry-types';
import { truncateOutput, withContinuationHint } from './truncate';

const DEFAULT_MAX_LENGTH = 8000;
const HTML_CONTENT_TYPES = new Set(['text/html', 'application/xhtml+xml']);

function looksLikeHtml(body: string, contentType: string): boolean {
    if (HTML_CONTENT_TYPES.has(contentType)) {
        return true;
    }
    const trimmed = body.slice(0, 600).trimStart().toLowerCase();
    return trimmed.startsWith('<!doctype html') || trimmed.startsWith('<html');
}

function toMarkdownViaNatives(natives: NativesClient | undefined, html: string): string | null {
    if (natives === undefined) {
        return null;
    }
    return natives.htmlToMarkdown(html, { cleanContent: true, skipImages: false });
}

const webfetchInputSchema = z.object({
    url: z.string().url(),
    maxLength: z.number().int().positive().optional(),
});
export type WebfetchInput = z.infer<typeof webfetchInputSchema>;

const webfetchOutputSchema = z.object({
    url: z.string(),
    status: z.number(),
    body: z.string(),
    truncated: z.boolean(),
});
export type WebfetchOutput = z.infer<typeof webfetchOutputSchema>;

export const webfetchToolRegistration: ToolRegistration<WebfetchInput, WebfetchOutput> = {
    name: 'webfetch',
    description: 'Fetch a URL and return its response body as text. Use for reading documentation or APIs.',
    capabilityClasses: ['network'],
    parametersJsonSchema: {
        type: 'object',
        properties: {
            url: { type: 'string', description: 'Absolute URL to fetch.' },
            maxLength: {
                type: 'integer',
                description: `Maximum body chars to return (default ${DEFAULT_MAX_LENGTH}).`,
            },
        },
        required: ['url'],
        additionalProperties: false,
    },
    inputSchema: webfetchInputSchema,
    outputSchema: webfetchOutputSchema,
    outputLimit: { maxModelOutputChars: 10_000 },
    execute: async (input, context) => fetchWebfetchOutput(input, context.signal, undefined),
    toModelOutput: (output) =>
        withContinuationHint(
            truncateOutput(output.body, 9800),
            output.truncated ? 'fetch again with a larger maxLength for the rest' : '',
        ),
};

/**
 * Fetch `input.url`, convert HTML bodies to Markdown via the native addon when
 * available (falling back to the raw body), and truncate to `maxLength`. The
 * static registration calls this with `natives: undefined` (raw body); the
 * self-gating factory injects a `NativesClient` so graph-path and noninteractive
 * runs get HTML->Markdown conversion when the addon is present.
 */
export async function fetchWebfetchOutput(
    input: WebfetchInput,
    signal: AbortSignal,
    natives: NativesClient | undefined,
    schemeResolver?: SchemeResolver,
): Promise<WebfetchOutput> {
    if (schemeResolver !== undefined) {
        const intercepted = await interceptWebfetch(schemeResolver, input.url);
        if (intercepted !== undefined) {
            const limit = input.maxLength ?? DEFAULT_MAX_LENGTH;
            const truncated = truncateOutput(intercepted.content, limit);
            return {
                url: input.url,
                status: 200,
                body: truncated.content,
                truncated: truncated.truncated,
            };
        }
    }
    const response = await fetch(input.url, { signal });
    if (!response.ok) {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: `webfetch ${input.url} returned HTTP ${response.status}`,
            retryable: true,
        });
    }
    const full = await response.text();
    const contentType = response.headers.get('content-type') ?? '';
    const body = looksLikeHtml(full, contentType) ? (toMarkdownViaNatives(natives, full) ?? full) : full;
    const limit = input.maxLength ?? DEFAULT_MAX_LENGTH;
    const truncated = truncateOutput(body, limit);
    return {
        url: input.url,
        status: response.status,
        body: truncated.content,
        truncated: truncated.truncated,
    };
}
