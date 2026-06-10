import {
    clampTextOffset,
    nextGraphemeOffset,
    previousGraphemeOffset,
    segmentTerminalText,
    terminalDisplayWidth,
    terminalOffsetForDisplayColumn,
} from './terminal-text.js';

export type TerminalChatCursorDirection =
    | 'left'
    | 'right'
    | 'up'
    | 'down'
    | 'line-start'
    | 'line-end'
    | 'input-start'
    | 'input-end'
    | 'word-left'
    | 'word-right';

export function moveTerminalChatCursorOffset(
    value: string,
    cursorOffset: number,
    direction: TerminalChatCursorDirection,
): number {
    const offset = clampTextOffset(value, cursorOffset);
    switch (direction) {
        case 'left':
            return previousGraphemeOffset(value, offset);
        case 'right':
            return nextGraphemeOffset(value, offset);
        case 'up':
            return moveTerminalChatInputCursorVertically(value, offset, -1);
        case 'down':
            return moveTerminalChatInputCursorVertically(value, offset, 1);
        case 'line-start':
            return findLineStartOffset(value, offset);
        case 'line-end':
            return findLineEndOffset(value, offset);
        case 'input-start':
            return 0;
        case 'input-end':
            return value.length;
        case 'word-left':
            return findPreviousWordStartOffset(value, offset);
        case 'word-right':
            return findNextWordStartOffset(value, offset);
        default:
            return assertNever(direction);
    }
}

function moveTerminalChatInputCursorVertically(value: string, cursorOffset: number, lineDelta: -1 | 1): number {
    const lines = splitInputLines(value);
    const cursorPosition = findCursorPosition(value, cursorOffset);
    const targetLineIndex = cursorPosition.lineIndex + lineDelta;
    if (targetLineIndex < 0 || targetLineIndex >= lines.length) {
        return cursorOffset;
    }
    return findOffsetForLineColumn(value, targetLineIndex, cursorPosition.column);
}

function findCursorPosition(
    value: string,
    cursorOffset: number,
): { readonly lineIndex: number; readonly column: number } {
    const beforeCursor = value.slice(0, clampTextOffset(value, cursorOffset));
    const linesBeforeCursor = beforeCursor.split('\n');
    const activeLine = linesBeforeCursor.at(-1) ?? '';
    return {
        lineIndex: linesBeforeCursor.length - 1,
        column: terminalDisplayWidth(activeLine),
    };
}

function findOffsetForLineColumn(value: string, lineIndex: number, column: number): number {
    const lines = splitInputLines(value);
    let offset = 0;
    for (let index = 0; index < lineIndex; index += 1) {
        offset += (lines[index]?.length ?? 0) + 1;
    }
    return offset + terminalOffsetForDisplayColumn(lines[lineIndex] ?? '', column);
}

function findLineStartOffset(value: string, cursorOffset: number): number {
    return value.lastIndexOf('\n', Math.max(0, cursorOffset - 1)) + 1;
}

function findLineEndOffset(value: string, cursorOffset: number): number {
    const nextLineBreakOffset = value.indexOf('\n', cursorOffset);
    return nextLineBreakOffset === -1 ? value.length : nextLineBreakOffset;
}

function findPreviousWordStartOffset(value: string, cursorOffset: number): number {
    const segments = segmentTerminalText(value);
    let index = segments.length - 1;
    while (index >= 0 && (segments[index]?.index ?? 0) >= cursorOffset) {
        index -= 1;
    }
    while (index >= 0 && !isWordSegment(segments[index]?.segment ?? '')) {
        index -= 1;
    }
    while (index > 0 && isWordSegment(segments[index - 1]?.segment ?? '')) {
        index -= 1;
    }
    return segments[index]?.index ?? 0;
}

function findNextWordStartOffset(value: string, cursorOffset: number): number {
    const segments = segmentTerminalText(value);
    let index = segments.findIndex((segment) => segment.index >= cursorOffset);
    if (index === -1) {
        return value.length;
    }
    if (isWordSegment(segments[index]?.segment ?? '')) {
        while (index < segments.length && isWordSegment(segments[index]?.segment ?? '')) {
            index += 1;
        }
    }
    while (index < segments.length && !isWordSegment(segments[index]?.segment ?? '')) {
        index += 1;
    }
    return segments[index]?.index ?? value.length;
}

function isWordSegment(segment: string): boolean {
    return /^[\p{L}\p{N}_]$/u.test(segment);
}

function splitInputLines(value: string): readonly string[] {
    const lines = value.split('\n');
    return lines.length === 0 ? [''] : lines;
}

function assertNever(value: never): never {
    throw new Error(`Unexpected terminal chat cursor direction: ${String(value)}`);
}
