/**
 * Pure chat/message primitives shared by the CLI noninteractive renderers and
 * the OpenTUI TUI. No React, no opentui, no node:ffi — only data shapes and
 * parse logic. Extracted from the CLI app so both packages compile during the
 * component move (Todo 4).
 */

export type ChatBlock = {
    readonly kind: 'user' | 'assistant' | 'error' | 'system' | 'tool' | 'thinking';
    readonly lines: readonly string[];
    /** Set when this block was tail-sliced or dropped for line budget (truncation marker). */
    readonly truncated?: boolean;
};

export const TOOL_LINE_PREFIXES: readonly string[] = [
    'Applied patch: ',
    'Applied edit: ',
    'Created file: ',
    'Replaced file: ',
    'Command output for ',
    'tool: ',
    '[Ctrl+O to expand/collapse]',
    'Edit preview for ',
    'Patch preview for ',
    'Command preview for ',
    'Write preview for ',
    'Replace preview for ',
    'Create preview for ',
];

export const TOOL_FAILURE_PATTERN = /^[A-Za-z][\w.-]* failed: /u;
export const TOOL_SUMMARY_PATTERN = /^\u2713 \d+ tools? /u;
export const TOOL_AGGREGATE_DISPLAY_PATTERN = /^\u2713 \d+ tools?(?: \([^\n]*\))?$/u;
export const THINKING_PREFIX = 'Thinking: ';

export function classifyLine(line: string): ChatBlock['kind'] {
    if (line.startsWith('You: ')) return 'user';
    if (line.startsWith('Assistant: ')) return 'assistant';
    if (line.startsWith('Error: ')) return 'error';
    if (line.startsWith(THINKING_PREFIX)) return 'thinking';
    if (TOOL_FAILURE_PATTERN.test(line)) return 'tool';
    if (TOOL_SUMMARY_PATTERN.test(line)) return 'tool';
    if (TOOL_LINE_PREFIXES.some((prefix) => line.startsWith(prefix))) return 'tool';
    return 'system';
}

export function isStrongBoundary(kind: ChatBlock['kind']): boolean {
    return kind === 'user' || kind === 'assistant' || kind === 'error' || kind === 'thinking';
}

/** Drop trailing empty lines so a block never ends on a blank (interior blanks survive as paragraph separators). */
export function trimTrailingEmptyLines(lines: readonly string[]): readonly string[] {
    let end = lines.length;
    while (end > 0 && (lines[end - 1] ?? '').length === 0) {
        end -= 1;
    }
    return lines.slice(0, end);
}

export function parseMessageBlocks(outputText: string): readonly ChatBlock[] {
    // Split without dropping empty lines: interior blanks are markdown paragraph
    // separators and must survive so a joined assistant block reconstructs the
    // original multi-paragraph text. Leading/trailing empties that would produce
    // an empty block are trimmed at flush.
    const rawLines = outputText.split('\n');
    const blocks: ChatBlock[] = [];
    let currentKind: ChatBlock['kind'] | undefined;
    let currentLines: string[] = [];

    const flush = (): void => {
        if (currentKind !== undefined && currentLines.length > 0) {
            const trimmed = trimTrailingEmptyLines(currentLines);
            if (trimmed.length > 0) {
                blocks.push({ kind: currentKind, lines: trimmed });
            }
        }
        currentKind = undefined;
        currentLines = [];
    };

    for (const line of rawLines) {
        if (TOOL_AGGREGATE_DISPLAY_PATTERN.test(line)) continue;
        const classified = classifyLine(line);
        // Continuation absorption keeps multi-line blocks together. Tool blocks
        // absorb any non-strong-boundary line (unchanged). Assistant and thinking
        // blocks absorb plain-text continuation + blank lines (system-classified)
        // so a multi-paragraph message stays one block, but they do NOT absorb
        // tool/user/error/thinking lines, which start new blocks instead.
        const absorbable =
            currentKind !== undefined &&
            ((currentKind === 'tool' && classified === 'system') ||
                ((currentKind === 'assistant' || currentKind === 'thinking') && classified === 'system'));
        if (absorbable) {
            currentLines.push(line);
            continue;
        }
        if ((currentKind === 'tool' && classified === 'tool') || classified !== currentKind) {
            flush();
            currentKind = classified;
        }
        currentLines.push(line);
    }
    flush();
    return blocks;
}

export const blockLeftColor: Record<ChatBlock['kind'], string | undefined> = {
    user: 'cyan',
    assistant: 'green',
    error: 'red',
    system: undefined,
    tool: 'yellow',
    thinking: 'magenta',
};

export const blockPrefix: Record<ChatBlock['kind'], string> = {
    user: 'You: ',
    assistant: 'Assistant: ',
    error: 'Error: ',
    system: '',
    tool: '',
    thinking: THINKING_PREFIX,
};

/** Join a block's lines into one markdown document, stripping the prefix from the first line only. */
export function joinBlockText(lines: readonly string[], prefix: string): string {
    if (lines.length === 0) return '';
    const first = lines[0] ?? '';
    const rest = lines.slice(1);
    const strippedFirst = prefix.length > 0 && first.startsWith(prefix) ? first.slice(prefix.length) : first;
    return rest.length === 0 ? strippedFirst : [strippedFirst, ...rest].join('\n');
}

/** Extract the last `Assistant:` block text from outputText; empty when none exists (for messages.copy). */
export function extractLastAssistantText(outputText: string): string {
    const blocks = parseMessageBlocks(outputText);
    for (let i = blocks.length - 1; i >= 0; i--) {
        const block = blocks[i];
        if (block?.kind === 'assistant') {
            return joinBlockText(block.lines, blockPrefix.assistant);
        }
    }
    return '';
}

export const TOOL_TITLE_PATTERN = /^(?:Edit|Patch|Command|Write|Replace|Create) preview for (\S+)/u;
export const TOOL_TITLE_PATTERN_2 =
    /^(?:Applied (?:patch|edit):|Created file:|Replaced file:|Command output for) (.+)$/u;

export function readToolBlockTitle(lines: readonly string[]): string | undefined {
    for (const line of lines) {
        const match1 = TOOL_TITLE_PATTERN.exec(line);
        if (match1 !== null) {
            return match1[1];
        }
        const match2 = TOOL_TITLE_PATTERN_2.exec(line);
        if (match2 !== null) {
            return match2[1];
        }
        if (line.startsWith('tool: ')) {
            return line.slice(6);
        }
    }
    return undefined;
}

// ---------------------------------------------------------------------------
// Question types (ask_user overlay option normalization).
// ---------------------------------------------------------------------------

/**
 * Labeled option for the `ask_user` overlay. `description` renders as dim
 * subtext beneath the label. Mirrors `AskUserOption` without crossing the
 * package boundary for a TUI-only value.
 */
export type QuestionOption = {
    readonly label: string;
    readonly description?: string;
};

/** One resolved entry in a multi-question batch; `header`/`multiple` defaulted, `options` normalized. */
export type QuestionBatchEntry = {
    readonly question: string;
    readonly header: string;
    readonly options: readonly QuestionOption[];
    readonly multiple: boolean;
};

/**
 * Normalize legacy `string[]` or labeled `{ label, description? }` options.
 * The conditional `description` spread honors `exactOptionalPropertyTypes`
 * by never emitting an explicit `undefined`.
 */
export function normalizeQuestionOptions(options: readonly (string | QuestionOption)[]): readonly QuestionOption[] {
    return options.map((option) => {
        if (typeof option === 'string') {
            return { label: option };
        }
        return {
            label: option.label,
            ...(option.description !== undefined ? { description: option.description } : {}),
        };
    });
}
