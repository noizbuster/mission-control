/**
 * `retain` tool — store durable facts in the configured memory backend.
 *
 * Config-gated seam: registers and advertises ONLY when `memory.backend !== 'off'`
 * (see {@linkcode registerMemoryRetainTool}). With the in-memory `local` stub the items
 * round-trip into the process-local Map and are retrievable via `recall`. With a deferred
 * backend (`mnemopi`/`hindsight`) the tool registers but returns `memory_backend_not_configured`.
 * Mirrors the reference oh-my-pi retain shape (arktype -> Zod) without the real backends.
 */
import { z } from 'zod';
import { isMemoryBackendActive, MEMORY_BACKEND_NOT_CONFIGURED, type MemoryBackend } from './memory-backend';
import { ToolRegistry } from './tool-registry';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types';

export const RETAIN_TOOL_NAME = 'retain';

export type RetainInput = z.infer<typeof retainInputSchema>;

export type RetainOutput = z.infer<typeof retainOutputSchema>;

const retainInputSchema = z.object({
    items: z
        .array(
            z
                .object({
                    content: z.string().min(1),
                    context: z.string().optional(),
                })
                .strict(),
        )
        .min(1),
});

const retainOutputSchema = z.object({
    status: z.enum(['stored', MEMORY_BACKEND_NOT_CONFIGURED]),
    count: z.number().int().nonnegative(),
    backend: z.string(),
});

const retainParametersJsonSchema = {
    type: 'object',
    properties: {
        items: {
            type: 'array',
            minItems: 1,
            description: 'Memories to retain. Each item has a content string and an optional source context.',
            items: {
                type: 'object',
                properties: {
                    content: { type: 'string', description: 'The information to remember.' },
                    context: { type: 'string', description: 'Optional source context for the memory.' },
                },
                required: ['content'],
                additionalProperties: false,
            },
        },
    },
    required: ['items'],
    additionalProperties: false,
} as const;

export function createMemoryRetainToolRegistration(
    backend: MemoryBackend,
): ToolRegistration<RetainInput, RetainOutput> {
    return {
        name: RETAIN_TOOL_NAME,
        description:
            'Store important facts in long-term memory. Each item is retained in the configured memory ' +
            'backend (off by default; the local stub is in-memory-only). Use for durable cross-session facts.',
        capabilityClasses: ['read'],
        parametersJsonSchema: retainParametersJsonSchema,
        inputSchema: retainInputSchema,
        outputSchema: retainOutputSchema,
        outputLimit: { maxModelOutputChars: 1_000 },
        execute: async (input) => {
            const result = await backend.retain(
                input.items.map((item) => ({ content: item.content, context: item.context, importance: undefined })),
            );
            return {
                status: result.status === 'ok' ? 'stored' : MEMORY_BACKEND_NOT_CONFIGURED,
                count: result.stored,
                backend: backend.id,
            };
        },
        toModelOutput: (output) =>
            output.status === 'stored'
                ? `${output.count} ${output.count === 1 ? 'memory' : 'memories'} stored (backend: ${output.backend}).`
                : `retain unavailable (backend: ${output.backend}): memory backend not configured.`,
    };
}

/** Register the retain tool only when the backend is active (`off` is the only gate). */
export function registerMemoryRetainTool(
    registry: ToolRegistry,
    backend: MemoryBackend,
): ToolAdvertisement | undefined {
    if (!isMemoryBackendActive(backend)) {
        return undefined;
    }
    return registry.register(createMemoryRetainToolRegistration(backend));
}
