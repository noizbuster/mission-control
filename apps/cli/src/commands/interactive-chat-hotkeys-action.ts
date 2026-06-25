import type { ModelProviderSelection } from '@mission-control/protocol';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import type { ChatOutput } from './interactive-chat-io.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';
import { terminalDisplayWidth } from './terminal-text.js';
import {
    type BindingValue,
    Definitions,
    Descriptions,
    expandToChords,
    type KeybindName,
    Keybinds,
    LeaderDefault,
} from '../platform/keymap/keybind.js';
import { resolveKeybindConfig } from '../platform/keymap/keybind-config-loader.js';

export type HotkeysAction = { readonly kind: 'hotkeys' };

/** The resolved keybinds shape produced by `Keybinds.parse`. */
type ResolvedKeybinds = ReturnType<typeof Keybinds.parse>;

export type HotkeyRow = { readonly key: string; readonly action: string };
export type HotkeyGroup = { readonly category: string; readonly rows: readonly HotkeyRow[] };

// ---------------------------------------------------------------------------
// Chord display formatting (registry chord strings -> human-readable glyphs)
// ---------------------------------------------------------------------------

const MODIFIER_DISPLAY: Readonly<Record<string, string>> = {
    ctrl: 'Ctrl',
    shift: 'Shift',
    meta: 'Alt',
    alt: 'Alt',
    super: 'Super',
    hyper: 'Hyper',
};

const KEY_DISPLAY_ALIASES: Readonly<Record<string, string>> = {
    return: 'Enter',
    kpenter: 'Enter',
    backspace: 'Backspace',
    delete: 'Delete',
    escape: 'Esc',
    pageup: 'PgUp',
    pagedown: 'PgDn',
    home: 'Home',
    end: 'End',
    tab: 'Tab',
    space: 'Space',
    left: '\u2190',
    right: '\u2192',
    up: '\u2191',
    down: '\u2193',
};

function formatKeyPiece(piece: string): string {
    const lower = piece.toLowerCase();
    const modifier = MODIFIER_DISPLAY[lower];
    if (modifier !== undefined) {
        return modifier;
    }
    const alias = KEY_DISPLAY_ALIASES[lower];
    if (alias !== undefined) {
        return alias;
    }
    if (/^[a-z]$/.test(piece)) {
        return piece.toUpperCase();
    }
    if (/^f\d{1,2}$/.test(lower)) {
        return piece.toUpperCase();
    }
    return piece;
}

function formatTokens(token: string): string {
    return token.split('+').map(formatKeyPiece).join('+');
}

/**
 * Format a single registry chord string for display. `<leader>` prefixes
 * resolve to the leader's display form joined to the suffix with a space
 * (two-key sequence), distinguishing them from simultaneous `+` chords.
 */
function formatChordPiece(chord: string, leaderDisplay: string): string {
    if (chord.startsWith('<leader>')) {
        const suffix = chord.slice('<leader>'.length);
        if (suffix.length === 0) {
            return leaderDisplay;
        }
        return `${leaderDisplay} ${formatTokens(suffix)}`;
    }
    return formatTokens(chord);
}

function formatBindingValueForDisplay(value: BindingValue, leaderDisplay: string): string {
    const chords = expandToChords(value);
    if (chords.length === 0) {
        return '';
    }
    return chords.map((chord) => formatChordPiece(chord, leaderDisplay)).join(', ');
}

// ---------------------------------------------------------------------------
// Registry grouping
// ---------------------------------------------------------------------------

const CATEGORY_PREFIXES: readonly { readonly prefix: string; readonly label: string }[] = [
    { prefix: 'model_', label: 'Models' },
    { prefix: 'agent_', label: 'Agents' },
    { prefix: 'session_', label: 'Sessions' },
    { prefix: 'messages_', label: 'Scrollback' },
    { prefix: 'which_key_', label: 'Which-Key' },
    { prefix: 'input_', label: 'Input Editing' },
];

function categorize(name: KeybindName): string {
    if (name === 'leader') {
        return 'Leader Key';
    }
    for (const entry of CATEGORY_PREFIXES) {
        if (name.startsWith(entry.prefix)) {
            return entry.label;
        }
    }
    return 'Quick Actions';
}

/**
 * Group every bound registry entry by category, in catalog declaration order
 * (leader, quick actions, models, agents, sessions, scrollback, which-key,
 * input editing). Unbound entries (`false` / `'none'`) are skipped so the
 * reference only lists keys that actually do something.
 */
export function buildHotkeyGroups(keybinds: ResolvedKeybinds = Keybinds.parse({})): readonly HotkeyGroup[] {
    const leaderRaw = typeof keybinds.leader === 'string' ? keybinds.leader : LeaderDefault;
    const leaderDisplay = formatTokens(leaderRaw);
    const groups = new Map<string, HotkeyRow[]>();
    const order: string[] = [];
    for (const name of Object.keys(Definitions) as KeybindName[]) {
        const value = keybinds[name];
        const keyDisplay = formatBindingValueForDisplay(value, leaderDisplay);
        if (keyDisplay.length === 0) {
            continue;
        }
        const category = categorize(name);
        let rows = groups.get(category);
        if (rows === undefined) {
            rows = [];
            groups.set(category, rows);
            order.push(category);
        }
        rows.push({ key: keyDisplay, action: Descriptions[name] });
    }
    const result: HotkeyGroup[] = [];
    for (const category of order) {
        const rows = groups.get(category);
        if (rows !== undefined) {
            result.push({ category, rows });
        }
    }
    return result;
}

/**
 * Render the keyboard-shortcut groups as a column-aligned block (category
 * headers + `  <key>  <action>` rows). Display-width-aware so wide glyphs
 * (arrows, CJK) align. Shared by `/hotkeys` and the `/help` keyboard section so
 * both reflect the SAME resolved registry.
 */
export function formatKeyboardShortcutsSection(keybinds: ResolvedKeybinds = Keybinds.parse({})): string {
    const groups = buildHotkeyGroups(keybinds);
    const lines: string[] = [];
    const keyColumnWidth = maxDisplayWidth(groups.flatMap((group) => group.rows.map((row) => row.key)));
    for (const group of groups) {
        lines.push(`${group.category}:`);
        for (const row of group.rows) {
            lines.push(`  ${padEndByDisplayWidth(row.key, keyColumnWidth)}  ${row.action}`);
        }
    }
    return lines.join('\n');
}

/**
 * Format the full `/hotkeys` reference as a grouped, column-aligned block.
 * Written as a plain system message (no prefix) so `parseMessageBlocks`
 * renders it as dim system text. Sources every chord + description from the
 * resolved keybind registry, so a `keybinds.json` override changes both the
 * runtime binding AND this output.
 */
export function formatHotkeysText(keybinds: ResolvedKeybinds = Keybinds.parse({})): string {
    const section = formatKeyboardShortcutsSection(keybinds);
    return `Keyboard Shortcuts:\n\n${section}\n\nTip: Rebind keys via keybinds.json; type / for commands.\n`;
}

export async function runHotkeysAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    activeTurn: ActiveCodingAgentTurn | undefined,
): Promise<ChatActionResult> {
    const { keybinds } = resolveKeybindConfig();
    chatOutput.write(formatHotkeysText(keybinds));
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
