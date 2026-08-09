/**
 * Pure extraction of the last complete You:/Assistant: exchange from legacy
 * outputText. Shared by the undo/redo keymap layer and ChatStore so typed and
 * legacy projections stay aligned.
 */

const USER_PREFIX = 'You: ';
const ASSISTANT_PREFIX = 'Assistant: ';

/** Strong boundaries that end an assistant block (mirrors parseMessageBlocks). */
const STRONG_BOUNDARY_PREFIXES: readonly string[] = [USER_PREFIX, ASSISTANT_PREFIX, 'Error: ', 'Thinking: '];

export type ExtractedExchange = {
    readonly exchangeText: string;
    readonly remaining: string;
    /** Byte offset where the exchange sat in the original outputText. */
    readonly insertOffset: number;
};

/**
 * Find the last complete `You:` + `Assistant:` exchange in `outputText`.
 * Returns undefined when no complete exchange exists.
 */
export function extractLastExchange(outputText: string): ExtractedExchange | undefined {
    const lines = outputText.split('\n');

    const assistantLineIndex = findLastLineWithPrefix(lines, ASSISTANT_PREFIX);
    if (assistantLineIndex === -1) return undefined;

    const userLineIndex = findLastLineWithPrefixBefore(lines, USER_PREFIX, assistantLineIndex);
    if (userLineIndex === -1) return undefined;

    const blockEndLine = findStrongBoundaryAfter(lines, assistantLineIndex);
    const insertOffset = lineStartOffset(lines, userLineIndex);
    const blockEndOffset = lineStartOffset(lines, blockEndLine);
    return {
        exchangeText: outputText.slice(insertOffset, blockEndOffset),
        remaining: outputText.slice(0, insertOffset) + outputText.slice(blockEndOffset),
        insertOffset,
    };
}

/**
 * Re-insert a previously extracted exchange at its original offset.
 * Byte-exact when `current` is the prior `remaining` string.
 */
export function reinsertExchange(current: string, exchangeText: string, insertOffset: number): string {
    const offset = Math.min(Math.max(0, insertOffset), current.length);
    return current.slice(0, offset) + exchangeText + current.slice(offset);
}

function findLastLineWithPrefix(lines: readonly string[], prefix: string): number {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        if ((lines[index] ?? '').startsWith(prefix)) return index;
    }
    return -1;
}

function findLastLineWithPrefixBefore(lines: readonly string[], prefix: string, before: number): number {
    for (let index = before - 1; index >= 0; index -= 1) {
        if ((lines[index] ?? '').startsWith(prefix)) return index;
    }
    return -1;
}

function findStrongBoundaryAfter(lines: readonly string[], from: number): number {
    for (let index = from + 1; index < lines.length; index += 1) {
        const line = lines[index] ?? '';
        if (STRONG_BOUNDARY_PREFIXES.some((prefix) => line.startsWith(prefix))) return index;
    }
    return lines.length;
}

function lineStartOffset(lines: readonly string[], lineIndex: number): number {
    let offset = 0;
    for (let index = 0; index < lineIndex; index += 1) {
        offset += (lines[index] ?? '').length + 1; // +1 for the split '\n'
    }
    return offset;
}
