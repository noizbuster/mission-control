import type { ModelProviderSelection } from '@mission-control/protocol';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import type { ChatOutput } from './interactive-chat-io.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';
import { terminalDisplayWidth } from './terminal-text.js';

export type HelpAction = { readonly kind: 'help' };

export type HelpCommand = { readonly id: string; readonly description: string };

export type KeyboardShortcut = { readonly key: string; readonly action: string };

/**
 * Keyboard shortcuts currently implemented in the Ink TUI (`handleInput`).
 * Only lists what is wired up — no aspirational entries.
 */
export const KEYBOARD_SHORTCUTS: readonly KeyboardShortcut[] = [
    { key: 'Enter', action: 'Send message' },
    { key: 'Shift+Enter', action: 'Insert newline (kitty-protocol terminals)' },
    { key: 'Alt+Enter', action: 'Insert newline (any terminal)' },
    { key: 'Backspace', action: 'Delete character before cursor' },
    { key: '\u2191/\u2193', action: 'Navigate input history (or slash command menu)' },
    { key: 'Ctrl+\u2190', action: 'Move cursor left by one word' },
    { key: 'Ctrl+\u2192', action: 'Move cursor right by one word' },
    { key: 'Ctrl+P', action: 'Cycle to next model' },
    { key: 'Shift+Ctrl+P', action: 'Cycle to previous model' },
    { key: 'Ctrl+T', action: 'Toggle thinking/reasoning display' },
    { key: 'Ctrl+O', action: 'Toggle tool output expand/collapse' },
    { key: 'Ctrl+E', action: 'Open external editor ($VISUAL/$EDITOR)' },
    { key: 'Ctrl+R', action: 'Rename session (inline overlay)' },
    { key: 'Ctrl+V', action: 'Paste image from clipboard (inserts temp file path)' },
    { key: 'PgUp', action: 'Scroll chat history up by one page' },
    { key: 'PgDn', action: 'Scroll chat history down by one page' },
    { key: 'Home', action: 'Jump to top of scrollback' },
    { key: 'End', action: 'Jump to bottom of scrollback' },
    { key: 'Ctrl+C', action: 'Interrupt (press twice to exit)' },
    {
        key: 'Esc',
        action:
            'Interrupt active run / clear input (double-Esc force-stops stuck runs; never exits)',
    },
    { key: 'Ctrl+D', action: 'Exit on empty input / forward-delete on non-empty' },
    { key: 'Ctrl+Z', action: 'Suspend to background (POSIX)' },
    { key: 'Ctrl+G', action: 'Toggle ABG monitoring overlay' },
] as const;

/**
 * Format a two-section help block: all available slash commands (aligned
 * columns) followed by all implemented keyboard shortcuts. Written as a
 * plain system message (no prefix) so `parseMessageBlocks` renders it as
 * dim system text.
 */
export function formatHelpText(commands: readonly HelpCommand[]): string {
    const lines: string[] = ['Commands:'];
    const commandColumnWidth = maxDisplayWidth(commands.map((command) => command.id));
    for (const command of commands) {
        lines.push(`  ${padEndByDisplayWidth(command.id, commandColumnWidth)}  ${command.description}`);
    }
    lines.push('');
    lines.push('Keyboard Shortcuts:');
    const shortcutColumnWidth = maxDisplayWidth(KEYBOARD_SHORTCUTS.map((shortcut) => shortcut.key));
    for (const shortcut of KEYBOARD_SHORTCUTS) {
        lines.push(`  ${padEndByDisplayWidth(shortcut.key, shortcutColumnWidth)}  ${shortcut.action}`);
    }
    lines.push('');
    lines.push('Tip: Type / followed by text to filter commands, or use arrow keys to navigate the menu.');
    return `${lines.join('\n')}\n`;
}

export async function runHelpAction(
    chatOutput: ChatOutput,
    commands: readonly HelpCommand[],
    modelProviderSelection: ModelProviderSelection,
    activeTurn: ActiveCodingAgentTurn | undefined,
): Promise<ChatActionResult> {
    chatOutput.write(formatHelpText(commands));
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
