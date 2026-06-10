import {
    createSlashCommandMenuView,
    formatSlashCommandMenuLines,
    type SlashCommandMenuState,
} from './interactive-chat-command-menu.js';
import {
    moveTerminalChatCursorOffset,
    type TerminalChatCursorDirection,
} from './interactive-chat-cursor-navigation.js';
import {
    clampTextOffset,
    previousGraphemeOffset,
    terminalDisplayWidth,
    truncateTerminalText,
} from './terminal-text.js';

export type TerminalChatInputStatus = {
    readonly providerID: string;
    readonly modelID: string;
};

export type TerminalChatInputBuffer = {
    readonly value: string;
    readonly cursorOffset: number;
};

export type TerminalChatInputBlock = {
    readonly text: string;
    readonly lineCount: number;
    readonly cursorLineIndex: number;
};

export type { TerminalChatCursorDirection };

const resetStyle = '\u001b[0m';
const inputStyle = '\u001b[48;5;236m';
const statusStyle = '\u001b[2m';
export function createTerminalChatInputBuffer(): TerminalChatInputBuffer {
    return { value: '', cursorOffset: 0 };
}

export function insertTerminalChatInputText(buffer: TerminalChatInputBuffer, text: string): TerminalChatInputBuffer {
    const cursorOffset = clampCursorOffset(buffer.value, buffer.cursorOffset);
    return {
        value: `${buffer.value.slice(0, cursorOffset)}${text}${buffer.value.slice(cursorOffset)}`,
        cursorOffset: cursorOffset + text.length,
    };
}

export function deleteTerminalChatInputCharacterBeforeCursor(buffer: TerminalChatInputBuffer): TerminalChatInputBuffer {
    const cursorOffset = clampCursorOffset(buffer.value, buffer.cursorOffset);
    if (cursorOffset === 0) {
        return buffer;
    }
    const previousOffset = previousGraphemeOffset(buffer.value, cursorOffset);
    return {
        value: `${buffer.value.slice(0, previousOffset)}${buffer.value.slice(cursorOffset)}`,
        cursorOffset: previousOffset,
    };
}

export function moveTerminalChatInputCursor(
    buffer: TerminalChatInputBuffer,
    direction: TerminalChatCursorDirection,
): TerminalChatInputBuffer {
    const cursorOffset = clampCursorOffset(buffer.value, buffer.cursorOffset);
    return { value: buffer.value, cursorOffset: moveTerminalChatCursorOffset(buffer.value, cursorOffset, direction) };
}

export function renderTerminalChatInputBlock(
    input: string | TerminalChatInputBuffer,
    state: SlashCommandMenuState,
    columns: number,
    status?: TerminalChatInputStatus,
): TerminalChatInputBlock {
    const buffer = toTerminalChatInputBuffer(input);
    const visibleColumns = getInputSurfaceColumns(columns);
    const menuView = createSlashCommandMenuView(buffer.value, state, 5);
    const menuLines = menuView.open ? formatSlashCommandMenuLines(menuView, columns) : [];
    const inputLines = formatInputSurfaceLines(buffer, visibleColumns, status);
    const cursorPosition = findCursorPosition(buffer.value, buffer.cursorOffset);
    const cursorLineIndex = menuLines.length + 1 + cursorPosition.lineIndex;
    const lineCount = menuLines.length + inputLines.length;
    const cursorColumn = Math.min(
        terminalDisplayWidth(getInputLinePrefix(cursorPosition.lineIndex)) + cursorPosition.column,
        visibleColumns,
    );
    return {
        text: `${[...menuLines, ...inputLines].join('\n')}${formatCursorMove(lineCount, cursorLineIndex, cursorColumn)}`,
        lineCount,
        cursorLineIndex,
    };
}

export function formatTerminalChatInputBlock(
    input: string | TerminalChatInputBuffer,
    state: SlashCommandMenuState,
    columns: number,
    status?: TerminalChatInputStatus,
): string {
    return renderTerminalChatInputBlock(input, state, columns, status).text;
}

export function formatTerminalChatCommittedInputLine(value: string, columns: number): string {
    const visibleColumns = getInputSurfaceColumns(columns);
    return splitInputLines(value)
        .map((line, index) => truncateTerminalText(`${getInputLinePrefix(index)}${line}`, visibleColumns))
        .join('\n');
}

export function countTerminalChatInputBlockLines(
    input: string | TerminalChatInputBuffer,
    state: SlashCommandMenuState,
    status?: TerminalChatInputStatus,
): number {
    return renderTerminalChatInputBlock(input, state, 100, status).lineCount;
}

function formatInputSurfaceLines(
    buffer: TerminalChatInputBuffer,
    columns: number,
    status: TerminalChatInputStatus | undefined,
): readonly string[] {
    const editorLines = splitInputLines(buffer.value).map((line, index) =>
        formatInputSurfaceLine(truncateTerminalText(formatEditableInputLine(line, index), columns), columns),
    );
    const blankLine = formatInputSurfaceLine('', columns);
    const statusLines =
        status === undefined
            ? []
            : [`${statusStyle}${truncateTerminalText(formatStatusText(status), columns)}${resetStyle}`];
    return [blankLine, ...editorLines, blankLine, ...statusLines];
}

function formatInputSurfaceLine(text: string, columns: number): string {
    const padding = ' '.repeat(Math.max(0, columns - terminalDisplayWidth(text)));
    return `${inputStyle}${text}${padding}${resetStyle}`;
}

function formatEditableInputLine(line: string, lineIndex: number): string {
    return `${getInputLinePrefix(lineIndex)}${line}`;
}

function formatStatusText(status: TerminalChatInputStatus): string {
    return `provider: ${status.providerID}  model: ${status.modelID}`;
}

function formatCursorMove(lineCount: number, cursorLineIndex: number, cursorColumn: number): string {
    const moveUpLines = Math.max(0, lineCount - 1 - cursorLineIndex);
    const moveUp = moveUpLines > 0 ? `\u001b[${moveUpLines}A` : '';
    const moveRight = cursorColumn > 0 ? `\u001b[${cursorColumn}C` : '';
    return `${moveUp}\r${moveRight}`;
}

function findCursorPosition(
    value: string,
    cursorOffset: number,
): { readonly lineIndex: number; readonly column: number } {
    const beforeCursor = value.slice(0, clampCursorOffset(value, cursorOffset));
    const linesBeforeCursor = beforeCursor.split('\n');
    const activeLine = linesBeforeCursor.at(-1) ?? '';
    return {
        lineIndex: linesBeforeCursor.length - 1,
        column: terminalDisplayWidth(activeLine),
    };
}

function splitInputLines(value: string): readonly string[] {
    const lines = value.split('\n');
    return lines.length === 0 ? [''] : lines;
}

function getInputLinePrefix(lineIndex: number): string {
    return lineIndex === 0 ? '> ' : '  ';
}

function getInputSurfaceColumns(columns: number): number {
    return Math.max(1, columns - 1);
}

function toTerminalChatInputBuffer(input: string | TerminalChatInputBuffer): TerminalChatInputBuffer {
    return typeof input === 'string' ? { value: input, cursorOffset: input.length } : input;
}

function clampCursorOffset(value: string, cursorOffset: number): number {
    return clampTextOffset(value, cursorOffset);
}
