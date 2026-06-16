/**
 * Token estimation for context packing (ABG §10.4, §14.2).
 *
 * Phase 2 uses a provider-agnostic char/4 heuristic so the Context Packer can decide when
 * to compact without a provider round-trip. Phase 5 replaces the per-turn estimate with the
 * provider's real `usage.inputTokens` when available (the packer reads whichever is present).
 *
 * The estimate is intentionally simple and stable: compaction must be deterministic for
 * replay (ABG §7.5) — a flaky token count would make the cut-point non-reproducible.
 */
import type { ModelMessage } from 'ai';

/** Rough chars-per-token ratio for the heuristic fallback. */
export const HEURISTIC_CHARS_PER_TOKEN = 4;

export function estimateStringTokens(text: string): number {
    if (text.length === 0) {
        return 0;
    }
    return Math.ceil(text.length / HEURISTIC_CHARS_PER_TOKEN);
}

/** Estimate the token cost of a single message (role + serialized content). */
export function estimateMessageTokens(message: ModelMessage): number {
    return estimateStringTokens(message.role) + estimateStringTokens(stringifyContent(message.content));
}

/** Estimate the token cost of a message list. */
export function estimateMessagesTokens(messages: readonly ModelMessage[]): number {
    return messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
}

function stringifyContent(content: ModelMessage['content']): string {
    if (typeof content === 'string') {
        return content;
    }
    // Array of content parts — concatenate the text-bearing fields deterministically.
    return content
        .map((part) => {
            if (part.type === 'text') {
                return part.text;
            }
            if (part.type === 'tool-call') {
                return `${part.toolName}:${JSON.stringify(part.input)}`;
            }
            if (part.type === 'tool-result') {
                return stringifyToolOutput(part.output);
            }
            if (part.type === 'reasoning') {
                return part.text;
            }
            return '';
        })
        .join('\n');
}

function stringifyToolOutput(output: unknown): string {
    if (typeof output === 'string') {
        return output;
    }
    try {
        return JSON.stringify(output);
    } catch {
        return String(output);
    }
}
