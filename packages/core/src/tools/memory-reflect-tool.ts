/**
 * `reflect` tool — synthesize an answer from the configured memory backend.
 *
 * Config-gated seam (see {@linkcode registerMemoryReflectTool}). With the in-memory `local`
 * stub it delegates to recall and formats the matches (no LLM synthesis in the stub). With a
 * deferred backend it returns `memory_backend_not_configured`. A real backend would answer a
 * question over the bank rather than return raw matches.
 */
import { z } from 'zod';
import { isMemoryBackendActive, MEMORY_BACKEND_NOT_CONFIGURED, type MemoryBackend } from './memory-backend.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types.js';

export const REFLECT_TOOL_NAME = 'reflect';

export type ReflectInput = z.infer<typeof reflectInputSchema>;

export type ReflectOutput = z.infer<typeof reflectOutputSchema>;

const reflectInputSchema = z.object({
    query: z.string().min(1),
    context: z.string().optional(),
});

const reflectOutputSchema = z.object({
    status: z.enum(['ok', 'empty', MEMORY_BACKEND_NOT_CONFIGURED]),
    text: z.string(),
    backend: z.string(),
});

const reflectParametersJsonSchema = {
    type: 'object',
    properties: {
        query: { type: 'string', description: 'The question to answer from memory.' },
        context: { type: 'string', description: 'Optional additional context to scope the synthesis.' },
    },
    required: ['query'],
    additionalProperties: false,
} as const;

export function createMemoryReflectToolRegistration(
    backend: MemoryBackend,
): ToolRegistration<ReflectInput, ReflectOutput> {
    return {
        name: REFLECT_TOOL_NAME,
        description:
            'Synthesize an answer from long-term memory. Asks the configured backend to reason over its ' +
            'bank (off by default; the local stub returns formatted recall matches rather than LLM synthesis).',
        capabilityClasses: ['read'],
        parametersJsonSchema: reflectParametersJsonSchema,
        inputSchema: reflectInputSchema,
        outputSchema: reflectOutputSchema,
        outputLimit: { maxModelOutputChars: 4_000 },
        execute: async (input) => {
            const result = await backend.reflect(input.query, input.context);
            return { status: result.status, text: result.text, backend: backend.id };
        },
        toModelOutput: (output) =>
            output.status === MEMORY_BACKEND_NOT_CONFIGURED
                ? `reflect unavailable (backend: ${output.backend}): memory backend not configured.`
                : output.text,
    };
}

/** Register the reflect tool only when the backend is active (`off` is the only gate). */
export function registerMemoryReflectTool(
    registry: ToolRegistry,
    backend: MemoryBackend,
): ToolAdvertisement | undefined {
    if (!isMemoryBackendActive(backend)) {
        return undefined;
    }
    return registry.register(createMemoryReflectToolRegistration(backend));
}
