import type { ModelProviderSelection } from '@mission-control/protocol';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import type { ChatOutput } from './interactive-chat-io.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';
import { terminalDisplayWidth } from './terminal-text.js';

export type HotkeysAction = { readonly kind: 'hotkeys' };

export type HotkeyEntry = { readonly key: string; readonly action: string };

export type HotkeyCategory = {
    readonly category: string;
    readonly shortcuts: readonly HotkeyEntry[];
};

/**
 * All keyboard shortcuts currently implemented in the Ink TUI (`handleInput`),
 * grouped by category. Only lists what is wired up — no aspirational entries.
 */
export const HOTKEYS_CATEGORIES: readonly HotkeyCategory[] = [
    {
        category: 'Input Editing',
        shortcuts: [
            { key: 'Enter', action: 'Send message / submit input' },
            { key: 'Shift+Enter', action: 'Insert newline (multi-line input)' },
            { key: 'Backspace', action: 'Delete character before cursor' },
            { key: 'Ctrl+D', action: 'Exit on empty input / forward-delete on non-empty' },
        ],
    },
    {
        category: 'Cursor Navigation',
        shortcuts: [
            { key: 'Ctrl+\u2190', action: 'Move cursor left by one word' },
            { key: 'Ctrl+\u2192', action: 'Move cursor right by one word' },
            { key: '\u2191/\u2193', action: 'Navigate input history / slash command menu' },
        ],
    },
    {
        category: 'Scrollback',
        shortcuts: [
            { key: 'PgUp', action: 'Scroll chat history up by one page' },
            { key: 'PgDn', action: 'Scroll chat history down by one page' },
            { key: 'Home', action: 'Jump to top of scrollback' },
            { key: 'End', action: 'Jump to bottom of scrollback' },
        ],
    },
    {
        category: 'Clipboard',
        shortcuts: [{ key: 'Ctrl+V', action: 'Paste image from clipboard (inserts temp file path)' }],
    },
    {
        category: 'Quick Actions',
        shortcuts: [
            { key: 'Ctrl+C', action: 'Interrupt (press twice to exit)' },
            { key: 'Esc', action: 'Interrupt active run / clear input (double-Esc: /tree or /fork via MCTRL_DOUBLE_ESC_ACTION)' },
            { key: 'Ctrl+Z', action: 'Suspend to background (POSIX; resume with fg)' },
            { key: 'Ctrl+P', action: 'Cycle to next model' },
            { key: 'Shift+Ctrl+P', action: 'Cycle to previous model' },
            { key: 'Ctrl+T', action: 'Toggle thinking/reasoning display' },
            { key: 'Ctrl+O', action: 'Toggle tool output expand/collapse' },
            { key: 'Ctrl+E', action: 'Open external editor ($VISUAL/$EDITOR)' },
            { key: 'Ctrl+R', action: 'Rename session (inline overlay)' },
            { key: 'Ctrl+G', action: 'Toggle ABG monitoring overlay' },
        ],
    },
    {
        category: 'Modes',
        shortcuts: [
            { key: '/model', action: 'Open model picker overlay' },
            { key: 'Approval prompt', action: 'Auto-shown for tool approval; Up/Down/Enter/Ctrl+C' },
            { key: 'Rename overlay', action: 'Ctrl+R to enter; Enter to confirm, Esc/Ctrl+C to cancel' },
        ],
    },
] as const;

/**
 * Format the full keyboard shortcut reference as a grouped, column-aligned
 * block. Written as a plain system message (no prefix) so `parseMessageBlocks`
 * renders it as dim system text. Mirrors the `formatHelpText` padding approach
 * (display-width-aware so wide arrow glyphs align).
 */
export function formatHotkeysText(): string {
    const lines: string[] = ['Keyboard Shortcuts:'];
    const keyColumnWidth = maxDisplayWidth(
        HOTKEYS_CATEGORIES.flatMap((group) => group.shortcuts.map((shortcut) => shortcut.key)),
    );
    for (const group of HOTKEYS_CATEGORIES) {
        lines.push('');
        lines.push(`${group.category}:`);
        for (const shortcut of group.shortcuts) {
            lines.push(`  ${padEndByDisplayWidth(shortcut.key, keyColumnWidth)}  ${shortcut.action}`);
        }
    }
    lines.push('');
    lines.push('Tip: Press Ctrl+P to cycle models, Ctrl+R to rename, or type / for commands.');
    return `${lines.join('\n')}\n`;
}

export async function runHotkeysAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    activeTurn: ActiveCodingAgentTurn | undefined,
): Promise<ChatActionResult> {
    chatOutput.write(formatHotkeysText());
    return actionResult(modelProviderSelection, activeTurn);
}

function maxDisplayWidth(values: readonly string[]): number {
    let maximum = 0;
    for (const value of values) {
        const width = terminalDisplayWidth(value);
        if (width > maximum) {
            maximum = width;
        }
    }
    return maximum;
}

function padEndByDisplayWidth(value: string, width: number): string {
    const padding = Math.max(0, width - terminalDisplayWidth(value));
    return `${value}${' '.repeat(padding)}`;
}
