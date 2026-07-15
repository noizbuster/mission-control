/**
 * `manage_skill` tool — create, update, or delete an isolated managed skill.
 *
 * Config-gated seam (see {@linkcode registerManageSkillTool}). The skill-write path is a
 * SEAM: execute returns `skill_seam_deferred` rather than writing a skill file. It registers
 * and advertises when `memory.backend !== 'off'` (grouped with the memory seams) but does
 * not touch the memory backend itself — managed-skill wiring to the real skill writer is
 * follow-up work. The `create`/`update` ops require both `description` and `body` (enforced
 * by a schema refine before execution).
 */
import { z } from 'zod';
import { isMemoryBackendActive, type MemoryBackend } from './memory-backend';
import { ToolRegistry } from './tool-registry';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types';

export const MANAGE_SKILL_TOOL_NAME = 'manage_skill';

export type ManageSkillInput = z.infer<typeof manageSkillInputSchema>;

export type ManageSkillOutput = z.infer<typeof manageSkillOutputSchema>;

const manageSkillInputSchema = z
    .object({
        action: z.enum(['create', 'update', 'delete']),
        name: z.string().min(1),
        description: z.string().optional(),
        body: z.string().optional(),
    })
    .strict()
    .refine((value) => value.action === 'delete' || (value.description !== undefined && value.body !== undefined), {
        message: 'manage_skill "create" and "update" require both "description" and "body".',
    });

const manageSkillOutputSchema = z.object({
    status: z.literal('skill_seam_deferred'),
    action: z.enum(['create', 'update', 'delete']),
    name: z.string(),
    backend: z.string(),
});

const manageSkillParametersJsonSchema = {
    type: 'object',
    properties: {
        action: { type: 'string', enum: ['create', 'update', 'delete'] },
        name: { type: 'string', description: 'Kebab-case skill name.' },
        description: {
            type: 'string',
            description: 'One-line description of when to use the skill (required for create/update).',
        },
        body: {
            type: 'string',
            description: 'The SKILL.md body in markdown, no frontmatter (required for create/update).',
        },
    },
    required: ['action', 'name'],
    additionalProperties: false,
} as const;

export function createManageSkillToolRegistration(
    backend: MemoryBackend,
): ToolRegistration<ManageSkillInput, ManageSkillOutput> {
    return {
        name: MANAGE_SKILL_TOOL_NAME,
        description:
            'Create, update, or delete an isolated managed skill. Deferred seam: registers and advertises ' +
            'but returns skill_seam_deferred until the managed-skill writer is wired. ' +
            'Config-gated: registers only when memory.backend is not off.',
        capabilityClasses: ['write'],
        parametersJsonSchema: manageSkillParametersJsonSchema,
        inputSchema: manageSkillInputSchema,
        outputSchema: manageSkillOutputSchema,
        outputLimit: { maxModelOutputChars: 1_000 },
        execute: async (input) => ({
            status: 'skill_seam_deferred',
            action: input.action,
            name: input.name,
            backend: backend.id,
        }),
        toModelOutput: (output) =>
            `manage_skill "${output.name}" (${output.action}) deferred: managed-skill writer is a seam ` +
            `(backend: ${output.backend}).`,
    };
}

/** Register the manage_skill tool only when the backend is active (`off` is the only gate). */
export function registerManageSkillTool(registry: ToolRegistry, backend: MemoryBackend): ToolAdvertisement | undefined {
    if (!isMemoryBackendActive(backend)) {
        return undefined;
    }
    return registry.register(createManageSkillToolRegistration(backend));
}
