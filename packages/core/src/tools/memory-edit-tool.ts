/**
 * `memory_edit` tool — update, forget, or invalidate a retained memory by id.
 *
 * Config-gated seam (see {@linkcode registerMemoryEditTool}). The `update` op requires
 * `content` or `importance` (enforced by a schema refine before execution). With the
 * in-memory `local` stub, edit mutates the process-local Map; `forget` and `invalidate`
 * both remove the record (the stub has no separate superseded store). With a deferred
 * backend it returns `memory_backend_not_configured`.
 */
import { z } from 'zod';
import { isMemoryBackendActive, MEMORY_BACKEND_NOT_CONFIGURED, type MemoryBackend } from './memory-backend.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types.js';

export const MEMORY_EDIT_TOOL_NAME = 'memory_edit';

export type MemoryEditInput = z.infer<typeof memoryEditInputSchema>;

export type MemoryEditOutput = z.infer<typeof memoryEditOutputSchema>;

const memoryEditInputSchema = z
    .object({
        op: z.enum(['update', 'forget', 'invalidate']),
        id: z.string().min(1),
        content: z.string().optional(),
        importance: z.number().min(0).max(1).optional(),
        replacement_id: z.string().optional(),
    })
    .strict()
    .refine((value) => value.op !== 'update' || value.content !== undefined || value.importance !== undefined, {
        message: 'memory_edit "update" requires "content" or "importance".',
    });

const memoryEditOutputSchema = z.object({
    status: z.enum(['updated', 'forgotten', 'invalidated', 'not_found', MEMORY_BACKEND_NOT_CONFIGURED]),
    id: z.string(),
    backend: z.string(),
});

const memoryEditParametersJsonSchema = {
    type: 'object',
    properties: {
        op: {
            type: 'string',
            enum: ['update', 'forget', 'invalidate'],
            description: 'update = replace content/importance; forget = delete; invalidate = supersede.',
        },
        id: { type: 'string', description: 'Memory id from a recall result.' },
        content: { type: 'string', description: 'Replacement content (required for update unless importance is set).' },
        importance: {
            type: 'number',
            minimum: 0,
            maximum: 1,
            description: 'Replacement importance, clamped to [0, 1] (required for update unless content is set).',
        },
        replacement_id: { type: 'string', description: 'Replacement memory id for invalidate.' },
    },
    required: ['op', 'id'],
    additionalProperties: false,
} as const;

export function createMemoryEditToolRegistration(
    backend: MemoryBackend,
): ToolRegistration<MemoryEditInput, MemoryEditOutput> {
    return {
        name: MEMORY_EDIT_TOOL_NAME,
        description:
            'Update, forget, or invalidate a retained memory by id. The id comes from a prior recall result. ' +
            'Config-gated: registers only when memory.backend is not off; the local stub is in-memory-only.',
        capabilityClasses: ['read'],
        parametersJsonSchema: memoryEditParametersJsonSchema,
        inputSchema: memoryEditInputSchema,
        outputSchema: memoryEditOutputSchema,
        outputLimit: { maxModelOutputChars: 1_000 },
        execute: async (input) => {
            const result = await backend.edit({
                op: input.op,
                id: input.id,
                content: input.content,
                importance: input.importance,
                replacementId: input.replacement_id,
            });
            if (result.status === MEMORY_BACKEND_NOT_CONFIGURED) {
                return { status: MEMORY_BACKEND_NOT_CONFIGURED, id: input.id, backend: backend.id };
            }
            if (result.status === 'not_found') {
                return { status: 'not_found', id: input.id, backend: backend.id };
            }
            const verb = input.op === 'update' ? 'updated' : input.op === 'forget' ? 'forgotten' : 'invalidated';
            return { status: verb, id: input.id, backend: backend.id };
        },
        toModelOutput: (output) => {
            if (output.status === MEMORY_BACKEND_NOT_CONFIGURED) {
                return `memory_edit unavailable (backend: ${output.backend}): memory backend not configured.`;
            }
            if (output.status === 'not_found') {
                return `Memory ${output.id} was not found.`;
            }
            return `Memory ${output.id} ${output.status}.`;
        },
    };
}

/** Register the memory_edit tool only when the backend is active (`off` is the only gate). */
export function registerMemoryEditTool(registry: ToolRegistry, backend: MemoryBackend): ToolAdvertisement | undefined {
    if (!isMemoryBackendActive(backend)) {
        return undefined;
    }
    return registry.register(createMemoryEditToolRegistration(backend));
}
