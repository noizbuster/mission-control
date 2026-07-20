/**
 * OpenCode-aligned chat chrome tokens for the interactive transcript and
 * prompt. Values mirror ref/opencode packages/tui theme asset `opencode.json`
 * dark steps so the output screen reads as the same product family without
 * importing @opencode-ai/* packages.
 */

/** Terminal background (darkStep1). */
export const CHAT_BG = '#0a0a0a';

/** User / tool panel fill (darkStep2). */
export const CHAT_PANEL_BG = '#141414';

/** Prompt textarea fill (darkStep3). */
export const CHAT_ELEMENT_BG = '#1e1e1e';

/** Primary accent — user message left bar / prompt border (darkStep9). */
export const CHAT_PRIMARY = '#fab283';

/** Secondary accent — links / secondary badges. */
export const CHAT_SECONDARY = '#5c9cf5';

/** Body text (darkStep12). */
export const CHAT_TEXT = '#eeeeee';

/** Muted labels, completed tools, timestamps (darkStep11). */
export const CHAT_TEXT_MUTED = '#808080';

/** Error left border and error body. */
export const CHAT_ERROR = '#e06c75';

/** Thinking / warning chrome. */
export const CHAT_WARNING = '#e5c07b';

/** Success / completed affirmative. */
export const CHAT_SUCCESS = '#7fd88f';

/** Diff added (OpenCode opencode.json dark `diffAdded`). */
export const CHAT_DIFF_ADDED = '#4fd6be';

/** Diff removed (OpenCode opencode.json dark `diffRemoved`). */
export const CHAT_DIFF_REMOVED = '#c53b53';

/** Placeholder text in the prompt. */
export const CHAT_PLACEHOLDER = '#606060';

/** Assistant text left inset matching OpenCode TextPart paddingLeft={3}. */
export const CHAT_ASSISTANT_PAD_LEFT = 3;

/** User panel padding (OpenCode UserMessage paddingTop/Bottom 1, Left 2). */
export const CHAT_USER_PAD_Y = 1;
export const CHAT_USER_PAD_X = 2;

/** Margin between successive user messages (OpenCode marginTop when index > 0). */
export const CHAT_USER_MARGIN_TOP = 1;

/** Inline tool icon column width (OpenCode INLINE_TOOL_ICON_WIDTH). */
export const CHAT_TOOL_ICON_WIDTH = 2;

/** Default inline tool icon (OpenCode GenericTool). */
export const CHAT_TOOL_ICON = '⚙';

/**
 * Map a tool title / first line to an OpenCode-style glyph.
 * Kept pure so unit tests can pin the vocabulary without rendering.
 */
export function toolIconForTitle(title: string | undefined): string {
    if (title === undefined || title.length === 0) return CHAT_TOOL_ICON;
    const lower = title.toLowerCase();
    if (lower.includes('bash') || lower.includes('command') || lower.startsWith('$')) return '$';
    if (lower.includes('todo')) return '☐';
    if (lower.includes('skill')) return '★';
    if (lower.includes('task') || lower.includes('agent')) return '◉';
    if (lower.includes('read') || lower.includes('repo.read')) return '→';
    if (lower.includes('write') || lower.includes('create') || lower.includes('replace')) return '←';
    if (lower.includes('edit') || lower.includes('patch')) return '←';
    if (lower.includes('grep') || lower.includes('search') || lower.includes('find')) return '✱';
    if (lower.includes('glob') || lower.includes('list') || lower.includes('ls')) return '✱';
    if (lower.includes('fetch') || lower.includes('web') || lower.includes('network')) return '%';
    return CHAT_TOOL_ICON;
}

/**
 * Build the collapsed/expanded inline tool header text (OpenCode-style, no `>`).
 * Collapsed appends a line-count hint; expanded is title only.
 */
export function buildInlineToolLabel(title: string | undefined, lineCount: number, expanded: boolean): string {
    const label = title !== undefined && title.length > 0 ? title : 'Tool output';
    if (expanded) return label;
    return `${label} (${lineCount} lines)`;
}
