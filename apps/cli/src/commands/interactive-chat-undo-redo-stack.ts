/**
 * Pure undo/redo state machine for the interactive chat.
 *
 * The stack stores message pairs that were REMOVED from the in-memory
 * conversation display by `/undo`, so `/redo` can restore them. It is
 * intentionally separate from the durable JSONL session log — undo/redo
 * never touches persisted state.
 *
 * All operations are immutable: they return a new {@link UndoRedoStack}
 * rather than mutating the receiver.
 */

export type MessagePair = {
    readonly userText: string;
    readonly assistantText: string;
};

export type UndoRedoStack = {
    /** Pairs removed by `/undo`, available for `/redo` (LIFO). */
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
    const last = stack.undonePairs[stack.undonePairs.length - 1];
    if (last === undefined) {
        return { stack, pair: undefined };
    }
    return {
        stack: { undonePairs: stack.undonePairs.slice(0, -1) },
        pair: last,
    };
}

export function isEmpty(stack: UndoRedoStack): boolean {
    return stack.undonePairs.length === 0;
}

const USER_PREFIX = 'You: ';
const ASSISTANT_PREFIX = 'Assistant: ';

/**
 * Scan `outputText` (the in-memory display buffer) for the last
 * `You: …` + `Assistant: …` pair. Returns the extracted pair and the
 * text with that pair removed, or `undefined` when no pair exists.
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
    const userLineIndex = findLastLineWithPrefix(lines.slice(0, assistantLineIndex), USER_PREFIX);
    if (userLineIndex === -1) {
        return undefined;
    }

    const userLine = lines[userLineIndex] ?? '';
    const assistantLine = lines[assistantLineIndex] ?? '';
    const userText = userLine.slice(USER_PREFIX.length);
    const assistantText = assistantLine.slice(ASSISTANT_PREFIX.length);

    const before = lines.slice(0, userLineIndex);
    const after = lines.slice(assistantLineIndex + 1);
    const remaining = [...before, ...after].join('\n');

    return {
        pair: { userText, assistantText },
        remaining,
    };
}

export function formatMessagePair(pair: MessagePair): string {
    return `You: ${pair.userText}\nAssistant: ${pair.assistantText}\n`;
}

function findLastLineWithPrefix(lines: readonly string[], prefix: string): number {
    for (let index = lines.length - 1; index >= 0; index -= 1) {
        const line = lines[index] ?? '';
        if (line.startsWith(prefix)) {
            return index;
        }
    }
    return -1;
}
