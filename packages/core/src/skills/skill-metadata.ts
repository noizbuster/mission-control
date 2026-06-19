/**
 * Skill metadata schema + types for the Agent Skills frontmatter format
 * (https://agentskills.io — used by opencode, oh-my-openagent, and pi).
 *
 * A SKILL.md file carries YAML frontmatter between `---` fences followed by a
 * markdown body. The frontmatter is operator-authored and parsed defensively:
 * malformed YAML or invalid metadata never crashes the loader (the offending
 * file is skipped with a diagnostic). The body is inert DATA and is never
 * evaluated — see skill-loader.ts.
 *
 * The raw `SkillMetadata` mirrors the frontmatter shape (optional fields stay
 * optional). The discovered `Skill` handle (see skill-loader.ts) defaults the
 * optional fields so callers always receive a fully-formed object.
 */
import { z } from 'zod';

/** Max length of a skill name (Agent Skills spec). */
export const SKILL_NAME_MAX_LENGTH = 64;
/** Max length of a skill description. */
export const SKILL_DESCRIPTION_MAX_LENGTH = 1024;

/**
 * Skill name validation (Agent Skills spec):
 * lowercase a-z, digits 0-9, and single hyphens; 1-64 chars;
 * no leading/trailing/double hyphens.
 */
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

/**
 * Zod schema for SKILL.md YAML frontmatter (opencode/omo format).
 *
 * Fields:
 * - `name`: required, validated against `SKILL_NAME_PATTERN` and length bounds.
 * - `description`: optional, bounded length; defaulted to '' on the `Skill` handle.
 * - `disableModelInvocation`: optional flag (opencode/omo) — when true, todo 9
 *   omits the skill from the `<available_skills>` block (model cannot invoke it
 *   directly; it is still loadable by name / slash command).
 */
export const SkillMetadataSchema = z.object({
    name: z
        .string()
        .min(1, 'skill name must not be empty')
        .max(SKILL_NAME_MAX_LENGTH, `skill name must be at most ${SKILL_NAME_MAX_LENGTH} chars`)
        .regex(SKILL_NAME_PATTERN, 'skill name must be lowercase alphanumeric with single hyphens'),
    description: z.string().max(SKILL_DESCRIPTION_MAX_LENGTH).optional(),
    disableModelInvocation: z.boolean().optional(),
});

/**
 * Raw frontmatter metadata (the shape written in the file).
 * Optional fields include `| undefined` to match zod v4's inference under
 * `exactOptionalPropertyTypes` (an absent key and an explicit `undefined` differ).
 */
export type SkillMetadata = {
    readonly name: string;
    readonly description?: string | undefined;
    readonly disableModelInvocation?: boolean | undefined;
};

/**
 * Validate an unknown parsed-YAML value against the skill metadata schema.
 * Returns the narrowed metadata on success or a human-readable error string.
 */
export function validateSkillMetadata(
    value: unknown,
): { readonly ok: true; readonly data: SkillMetadata } | { readonly ok: false; readonly error: string } {
    const result = SkillMetadataSchema.safeParse(value);
    if (!result.success) {
        const detail = result.error.issues
            .map((issue) => {
                const path = issue.path.length === 0 ? '<root>' : issue.path.map(String).join('.');
                return `${path}: ${issue.message}`;
            })
            .join('; ');
        return { ok: false, error: `frontmatter validation failed: ${detail}` };
    }
    return { ok: true, data: result.data };
}
