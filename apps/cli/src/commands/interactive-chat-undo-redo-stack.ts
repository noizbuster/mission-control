/**
 * Pure undo/redo state machine for the interactive chat.
 *
 * The stack stores message pairs that were REMOVED from the in-memory
 * conversation display by `/undo`, so `/redo` can restore them. It is
 * intentionally separate from the durable session store — undo/redo
 * never touches persisted state.
 *
 * All operations are immutable: they return a new {@link UndoRedoStack}
 * rather than mutating the receiver.
 *
 * When a TUI handle is present, interactive-chat prefers ChatStore
 * `undoLastViewExchange` / `redoLastViewExchange` so typed transcriptParts
 * stay aligned. This module remains the non-TUI / fallback path.
 */

export type MessagePair = {
    readonly userText: string;
    readonly assistantText: string;
    /** Raw exchange substring when multi-line extraction was used (preferred for redo). */
    readonly exchangeText?: string;
};

export type UndoRedoStack = {
    readonly undonePairs: readonly MessagePair[];
};

export function createUndoRedoStack(): UndoRedoStack {
    return { undonePairs: [] };
}

export function pushUndonePair(stack: UndoRedoStack, pair: MessagePair): UndoRedoStack {
    return { undonePairs: [...stack.undonePairs, pair] };
}

export function popUndonePair(stack: UndoRedoStack): {
    readonly stack: UndoRedoStack;
    readonly pair: MessagePair | undefined;
} {
    if (stack.undonePairs.length === 0) {
        return { stack, pair: undefined };
    }
    const pair = stack.undonePairs[stack.undonePairs.length - 1];
    if (pair === undefined) {
        return { stack, pair: undefined };
    }
    return {
        stack: { undonePairs: stack.undonePairs.slice(0, -1) },
        pair,
    };
}

export function isEmpty(stack: UndoRedoStack): boolean {
    return stack.undonePairs.length === 0;
}

const USER_PREFIX = 'You: ';
const ASSISTANT_PREFIX = 'Assistant: ';
const STRONG_BOUNDARY_PREFIXES: readonly string[] = [USER_PREFIX, ASSISTANT_PREFIX, 'Error: ', 'Thinking: '];

/**
 * Scan `outputText` for the last complete `You:` + `Assistant:` exchange.
 * Captures the full multi-line assistant block through the next strong
 * boundary (or EOF), matching the TUI view undo extractor.
 */
export function extractLastMessagePair(outputText: string):
    | {
          readonly pair: MessagePair;
          readonly remaining: string;
      }
    | undefined {
    const lines = outputText.split('\n');

    const assistantLineIndex = findLastLineWithPrefix(lines, ASSISTANT_PREFIX);
    if (assistantLineIndex === -1) {
        return undefined;
    }
    const userLineIndex = findLastLineWithPrefixBefore(lines, USER_PREFIX, assistantLineIndex);
    if (userLineIndex === -1) {
        return undefined;
    }

    const blockEndLine = findStrongBoundaryAfter(lines, assistantLineIndex);
    const insertOffset = lineStartOffset(lines, userLineIndex);
    const blockEndOffset = lineStartOffset(lines, blockEndLine);
    const exchangeText = outputText.slice(insertOffset, blockEndOffset);
    const remaining = outputText.slice(0, insertOffset) + outputText.slice(blockEndOffset);

    const userLine = lines[userLineIndex] ?? '';
    const assistantLines = lines.slice(assistantLineIndex, blockEndLine);
    const assistantText = assistantLines
        .map((line, index) => (index === 0 ? line.slice(ASSISTANT_PREFIX.length) : line))
        .join('\n');

    return {
        pair: {
            userText: userLine.slice(USER_PREFIX.length),
            assistantText,
            exchangeText,
        },
        remaining,
    };
}

export function formatMessagePair(pair: MessagePair): string {
    if (pair.exchangeText !== undefined && pair.exchangeText.length > 0) {
        return pair.exchangeText;
    }
    return `You: ${pair.userText}\nAssistant: ${pair.assistantText}\n`;
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
        offset += (lines[index] ?? '').length + 1;
    }
    return offset;
}
