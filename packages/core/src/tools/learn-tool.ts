/**
 * `learn` tool — capture a reusable lesson to memory, and optionally mint a managed skill.
 *
 * Config-gated seam (see {@linkcode registerLearnTool}). Two parts:
 *  - The lesson is persisted via the configured memory backend (the in-memory `local` stub
 *    stores it in the process-local Map; a deferred backend returns not_configured).
 *  - The optional managed-skill mint is a SEAM: it returns `skill_seam_deferred` rather than
 *    writing a skill file. Wiring it to the real managed-skill writer is follow-up work; this
 *    seam keeps the tool surface and contract stable first.
 *
 * Mirrors the reference oh-my-pi learn shape (arktype -> Zod) without the skill-writer.
 */
import { z } from 'zod';
import { isMemoryBackendActive, MEMORY_BACKEND_NOT_CONFIGURED, type MemoryBackend } from './memory-backend.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types.js';

export const LEARN_TOOL_NAME = 'learn';

export type LearnInput = z.infer<typeof learnInputSchema>;

export type LearnOutput = z.infer<typeof learnOutputSchema>;

const learnInputSchema = z.object({
    memory: z.string().min(1),
    context: z.string().optional(),
    skill: z
        .object({
            action: z.enum(['create', 'update']),
            name: z.string().min(1),
            description: z.string().min(1),
            body: z.string().min(1),
        })
        .strict()
        .optional(),
});

const learnOutputSchema = z.object({
    memoryStatus: z.enum(['stored', MEMORY_BACKEND_NOT_CONFIGURED]),
    skillStatus: z.enum(['deferred', 'not_requested']),
    backend: z.string(),
});

const learnParametersJsonSchema = {
    type: 'object',
    properties: {
        memory: {
            type: 'string',
            description: 'The durable, self-contained lesson to remember (what, when, why).',
        },
        context: { type: 'string', description: 'Optional source context for the lesson.' },
        skill: {
            type: 'object',
            description: 'Optionally create or enhance a managed skill in the same call. Currently a deferred seam.',
            properties: {
                action: { type: 'string', enum: ['create', 'update'] },
                name: { type: 'string', description: 'Kebab-case skill name.' },
                description: { type: 'string', description: 'One-line description of when to use the skill.' },
                body: { type: 'string', description: 'The SKILL.md body in markdown (no frontmatter).' },
            },
            required: ['action', 'name', 'description', 'body'],
            additionalProperties: false,
        },
    },
    required: ['memory'],
    additionalProperties: false,
} as const;

export function createLearnToolRegistration(backend: MemoryBackend): ToolRegistration<LearnInput, LearnOutput> {
    return {
        name: LEARN_TOOL_NAME,
        description:
            'Capture a reusable lesson to long-term memory and optionally mint a managed skill. The lesson ' +
            'persist path uses the configured memory backend; the managed-skill path is a deferred seam. ' +
            'Config-gated: registers only when memory.backend is not off.',
        capabilityClasses: ['write'],
        parametersJsonSchema: learnParametersJsonSchema,
        inputSchema: learnInputSchema,
        outputSchema: learnOutputSchema,
        outputLimit: { maxModelOutputChars: 1_000 },
        execute: async (input) => {
            const result = await backend.retain([{ content: input.memory, context: input.context, importance: 0.8 }]);
            return {
                memoryStatus: result.status === 'ok' ? 'stored' : MEMORY_BACKEND_NOT_CONFIGURED,
                skillStatus: input.skill !== undefined ? 'deferred' : 'not_requested',
                backend: backend.id,
            };
        },
        toModelOutput: (output) => {
            const memoryText = output.memoryStatus === 'stored' ? 'Lesson stored' : 'memory backend not configured';
            const skillText = output.skillStatus === 'deferred' ? '; managed-skill mint deferred (seam)' : '';
            return `${memoryText} (backend: ${output.backend})${skillText}.`;
        },
    };
}

/** Register the learn tool only when the backend is active (`off` is the only gate). */
export function registerLearnTool(registry: ToolRegistry, backend: MemoryBackend): ToolAdvertisement | undefined {
    if (!isMemoryBackendActive(backend)) {
        return undefined;
    }
    return registry.register(createLearnToolRegistration(backend));
}
