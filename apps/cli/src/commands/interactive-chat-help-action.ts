import type { ModelProviderSelection } from '@mission-control/protocol';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import type { ChatOutput } from './interactive-chat-io.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';
import { terminalDisplayWidth } from './terminal-text.js';
import { Keybinds } from '../platform/keymap/keybind.js';
import { resolveKeybindConfig } from '../platform/keymap/keybind-config-loader.js';
import { formatKeyboardShortcutsSection } from './interactive-chat-hotkeys-action.js';

export type HelpAction = { readonly kind: 'help' };

export type HelpCommand = { readonly id: string; readonly description: string };

/** The resolved keybinds shape produced by `Keybinds.parse`. */
type ResolvedKeybinds = ReturnType<typeof Keybinds.parse>;

/**
 * Format a two-section help block: all available slash commands (aligned
 * columns) followed by the keyboard shortcuts. Both sections are registry- or
 * config-driven: commands come from the slash menu, and the keyboard section
 * is rendered from the resolved keybind registry (shared with `/hotkeys`) so a
 * `keybinds.json` override is reflected in both `/help` and `/hotkeys`.
 *
 * Written as a plain system message (no prefix) so `parseMessageBlocks`
 * renders it as dim system text.
 */
export function formatHelpText(
    commands: readonly HelpCommand[],
    keybinds: ResolvedKeybinds = Keybinds.parse({}),
): string {
    const lines: string[] = ['Commands:'];
    const commandColumnWidth = maxDisplayWidth(commands.map((command) => command.id));
    for (const command of commands) {
        lines.push(`  ${padEndByDisplayWidth(command.id, commandColumnWidth)}  ${command.description}`);
    }
    lines.push('');
    lines.push('Keyboard Shortcuts:');
    lines.push('');
    lines.push(formatKeyboardShortcutsSection(keybinds));
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
    const { keybinds } = resolveKeybindConfig();
    chatOutput.write(formatHelpText(commands, keybinds));
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
