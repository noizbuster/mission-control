/**
 * `recall` tool — search the configured memory backend for relevant prior context.
 *
 * Config-gated seam (see {@linkcode registerMemoryRecallTool}). With the in-memory `local`
 * stub this is the read side of the retain -> recall round-trip: it searches the process-
 * local Map. With a deferred backend it returns `memory_backend_not_configured`.
 */
import { z } from 'zod';
import { isMemoryBackendActive, MEMORY_BACKEND_NOT_CONFIGURED, type MemoryBackend } from './memory-backend';
import { ToolRegistry } from './tool-registry';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types';

export const RECALL_TOOL_NAME = 'recall';

export type RecallInput = z.infer<typeof recallInputSchema>;

export type RecallOutput = z.infer<typeof recallOutputSchema>;

const recallInputSchema = z.object({
    query: z.string().min(1),
});

const recallOutputSchema = z.object({
    status: z.enum(['ok', 'empty', MEMORY_BACKEND_NOT_CONFIGURED]),
    count: z.number().int().nonnegative(),
    memories: z.array(
        z.object({
            id: z.string(),
            content: z.string(),
            context: z.string().optional(),
            importance: z.number(),
        }),
    ),
    backend: z.string(),
});

const recallParametersJsonSchema = {
    type: 'object',
    properties: {
        query: { type: 'string', description: 'Natural language search query for prior memories.' },
    },
    required: ['query'],
    additionalProperties: false,
} as const;

export function createMemoryRecallToolRegistration(
    backend: MemoryBackend,
): ToolRegistration<RecallInput, RecallOutput> {
    return {
        name: RECALL_TOOL_NAME,
        description:
            'Search process-local memory for relevant prior context. The local backend is in-memory-only ' +
            'and does not persist across registry or process lifetimes.',
        capabilityClasses: ['read'],
        parametersJsonSchema: recallParametersJsonSchema,
        inputSchema: recallInputSchema,
        outputSchema: recallOutputSchema,
        outputLimit: { maxModelOutputChars: 4_000 },
        execute: async (input) => {
            const result = await backend.recall(input.query);
            return {
                status: result.status,
                count: result.memories.length,
                memories: result.memories.map((memory) => ({
                    id: memory.id,
                    content: memory.content,
                    context: memory.context,
                    importance: memory.importance,
                })),
                backend: backend.id,
            };
        },
        toModelOutput: (output) => {
            if (output.status === MEMORY_BACKEND_NOT_CONFIGURED) {
                return `recall unavailable (backend: ${output.backend}): memory backend not configured.`;
            }
            if (output.count === 0) {
                return 'No relevant memories found.';
            }
            const listing = output.memories
                .map((memory, index) => `${index + 1}. [${memory.id}] ${memory.content}`)
                .join('\n');
            return `Found ${output.count} ${output.count === 1 ? 'memory' : 'memories'}:\n${listing}`;
        },
    };
}

/** Register the recall tool only when the backend is active (`off` is the only gate). */
export function registerMemoryRecallTool(
    registry: ToolRegistry,
    backend: MemoryBackend,
): ToolAdvertisement | undefined {
    if (!isMemoryBackendActive(backend)) {
        return undefined;
    }
    return registry.register(createMemoryRecallToolRegistration(backend));
}
