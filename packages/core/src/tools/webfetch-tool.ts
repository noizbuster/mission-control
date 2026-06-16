/**
 * `webfetch` tool — fetch a URL and return its body (opencode/pi surface, Phase 4).
 *
 * Uses the runtime `fetch`. Body is returned as text and truncated with a continuation hint.
 * Errors (non-2xx, network) surface as a `ToolExecutionError` so the model can read + adjust.
 */
import { z } from 'zod';
import type { ToolRegistration } from './tool-registry-types.js';
import { ToolExecutionError } from './tool-registry-types.js';
import { truncateOutput, withContinuationHint } from './truncate.js';

const DEFAULT_MAX_LENGTH = 8000;

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
    execute: async (input, context) => {
        const response = await fetch(input.url, { signal: context.signal });
        if (!response.ok) {
            throw new ToolExecutionError({
                code: 'tool_failed',
                message: `webfetch ${input.url} returned HTTP ${response.status}`,
                retryable: true,
            });
        }
        const full = await response.text();
        const limit = input.maxLength ?? DEFAULT_MAX_LENGTH;
        const truncated = truncateOutput(full, limit);
        return {
            url: input.url,
            status: response.status,
            body: truncated.content,
            truncated: truncated.truncated,
        };
    },
    toModelOutput: (output) =>
        withContinuationHint(
            truncateOutput(output.body, 9800),
            output.truncated ? 'fetch again with a larger maxLength for the rest' : '',
        ),
};
