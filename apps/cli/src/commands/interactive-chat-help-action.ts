import type { ModelProviderSelection } from '@mission-control/protocol';
import { padEndToDisplayWidth, terminalDisplayWidth } from '@mission-control/tui';
import { Keybinds } from '@mission-control/tui/keybind';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result';
import { formatKeyboardShortcutsSection } from './interactive-chat-hotkeys-action';
import type { ChatOutput } from './interactive-chat-io';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent';

export type HelpAction = { readonly kind: 'help' };

export type HelpCommand = { readonly id: string; readonly description: string };

/** The resolved keybinds shape produced by `Keybinds.parse`. */
type ResolvedKeybinds = ReturnType<typeof Keybinds.parse>;

/**
 * Format a multi-section help block: slash commands (aligned columns), static
 * prefix commands (`$` / `!` / `!!`), then keyboard shortcuts. Slash commands
 * come from the slash menu; the keyboard section is rendered from the resolved
 * keybind registry (shared with `/hotkeys`) so a `keybinds.json` override is
 * reflected in both `/help` and `/hotkeys`.
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
        lines.push(`  ${padEndToDisplayWidth(command.id, commandColumnWidth)}  ${command.description}`);
    }
    lines.push('');
    lines.push(...formatPrefixCommandsSection());
    lines.push('');
    lines.push('Keyboard Shortcuts:');
    lines.push('');
    lines.push(formatKeyboardShortcutsSection(keybinds));
    lines.push('');
    lines.push('Tip: Type / followed by text to filter commands, or use arrow keys to navigate the menu.');
    return `${lines.join('\n')}\n`;
}

function formatPrefixCommandsSection(): readonly string[] {
    const entries = [
        { id: '$name [args]', description: 'Load a skill and submit its body as the next user message' },
        { id: '!command', description: 'Run a shell command and submit the output to the model' },
        { id: '!!command', description: 'Run a shell command and display the output only (no model submit)' },
        { id: '/trust', description: 'Trust this workspace (required before ! / !! bash)' },
    ] as const;
    const columnWidth = maxDisplayWidth(entries.map((entry) => entry.id));
    return [
        'Prefix commands:',
        ...entries.map(
            (entry) => `  ${padEndToDisplayWidth(entry.id, columnWidth)}  ${entry.description}`,
        ),
    ];
}

export async function runHelpAction(
    chatOutput: ChatOutput,
    commands: readonly HelpCommand[],
    modelProviderSelection: ModelProviderSelection,
    activeTurn: ActiveCodingAgentTurn | undefined,
): Promise<ChatActionResult> {
    // Lazy-load so the noninteractive `--no-tui` graph never transitively loads the keybind-config-loader module. `/help` is interactive-only.
    const { resolveKeybindConfig } = await import('@mission-control/tui/keybind-config');
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
