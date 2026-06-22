/**
 * Child-agent system prompt assembly.
 *
 * Assembles the system prompt for a spawned child agent from up to four layers:
 *   1. Subagent base directive — delegation contract + `yield` tool instruction
 *   2. Role preamble — specialization line when a non-blank role is supplied
 *   3. Agent body — the {@linkcode AgentDefinition.systemPrompt}
 *   4. Parent context — shared context in batch-spawn mode
 *
 * The child's identity is independent of the parent's persona; this module does
 * NOT inject the parent's system prompt. Empty layers are omitted so the prompt
 * never contains a blank section.
 */
import type { AgentDefinition } from '@mission-control/protocol';

/**
 * Base directive every delegated subagent receives. Establishes the delegation
 * contract and instructs the child to submit results via the `yield` tool.
 */
export const SUBAGENT_BASE_DIRECTIVE =
    'You are a delegated subagent. Complete your assigned task and call the `yield` tool with your result when done.';

export interface BuildChildSystemPromptInput {
    readonly agent: AgentDefinition;
    readonly parentContext?: string;
    readonly role?: string;
}

const SECTION_SEPARATOR = '\n\n';

/**
 * Sanitizes a role label for safe embedding in a system-prompt preamble.
 *
 * Replaces control characters (Unicode category `Cc` — C0 0x00-0x1F, DEL 0x7F,
 * C1 0x80-0x9F) and format characters (category `Cf` — zero-width space/joiner,
 * BOM) with a single space, collapses internal whitespace, and trims. Returns
 * `undefined` when nothing printable remains so the caller can skip the layer.
 */
function sanitizeRole(role: string): string | undefined {
    const cleaned = role
        .replace(/[\p{Cc}\p{Cf}]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * Builds the child agent's system prompt from layered composition.
 *
 * Layer order: base directive → role preamble → agent body → parent context.
 * Each optional layer is omitted when blank or absent.
 */
export function buildChildSystemPrompt(input: BuildChildSystemPromptInput): string {
    const layers: string[] = [];

    layers.push(SUBAGENT_BASE_DIRECTIVE);

    const sanitizedRole = sanitizeRole(input.role ?? '');
    if (sanitizedRole !== undefined) {
        layers.push(`Specializing as: **${sanitizedRole}**`);
    }

    if (input.agent.systemPrompt.length > 0) {
        layers.push(input.agent.systemPrompt);
    }

    if (input.parentContext !== undefined && input.parentContext.length > 0) {
        layers.push(`Shared context:\n${input.parentContext}`);
    }

    return layers.join(SECTION_SEPARATOR);
}
