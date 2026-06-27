/**
 * Slash-command palette classification table (T8).
 *
 * mctrl's interactive slash menu (`slashCommandChoices` in
 * interactive-chat-command-menu.ts) lists every `/`-command the user can type.
 * Not all of them belong in the Alt+X command palette: the palette surfaces
 * argument-less, fire-and-forget commands. Argument-taking / subcommand
 * commands stay in the typed `/`-menu, where `parseChatLine` /
 * `resolveUnreservedSlash` (chat-commands.ts) is the EXECUTION truth and is
 * untouched here.
 *
 * This module is the DISPLAY truth for which slash commands surface in the
 * palette. It is a NEW classification layer OVER `slashCommandChoices`; it
 * neither alters `parseChatLine` nor removes anything from the slash menu. The
 * command-palette component reads `getPaletteSlashCommands()` to merge the
 * argument-less slash set into its list alongside the keymap's reachable
 * commands.
 *
 * Classification is by BASE command name (the first token after `/`), so the
 * `/model pick`, `/trust deny`, and `/approval verbose` subcommand variants all
 * collapse to their base (`model` / `trust` / `approval`) and inherit the
 * base's classification.
 *
 * Pure data + pure functions: no opentui, no keymap, no I/O — safe to unit-test
 * without a TTY or native FFI backend.
 */

import { slashCommandChoices } from '../../commands/interactive-chat-command-menu.js';

/** A slash command surfaceable in the command palette (argument-less). */
export interface PaletteSlashEntry {
    /** Base command name WITHOUT the leading `/` (e.g. `exit`). */
    readonly slashName: string;
    /** Display form WITH the leading `/` (e.g. `/exit`). */
    readonly display: string;
    /** Human description, sourced from `slashCommandChoices`. */
    readonly description: string;
}

/** The two classification buckets for a slash command base name. */
export type SlashCommandClassification = 'registry-slash' | 'parsechatline-only';

/**
 * Extract the base command name from a slash-menu id. Strips the leading `/`
 * and any subcommand tail, so `/model pick` -> `model`, `/trust deny` ->
 * `trust`, `/exit` -> `exit`.
 */
export function slashBaseName(id: string): string {
    const withoutSlash = id.startsWith('/') ? id.slice(1) : id;
    const firstSpace = withoutSlash.indexOf(' ');
    return firstSpace === -1 ? withoutSlash : withoutSlash.slice(0, firstSpace);
}

/**
 * Argument-less slash commands that surface in the palette. Pinned by the T8
 * task spec. Each is invokable bare (no required argument) and resolves in
 * `parseChatLine` via `parseNoArgumentCommand` (`exit`/`help`/`hotkeys`/
 * `interrupt`/`resume`/`continue`) or `resolveUnreservedSlash` -> `parseSessionSlashCommand`
 * (`sessions`/`tree`) or `parseCompactCommand` (`compact`).
 *
 * `/compact` accepts OPTIONAL focus text and `/tree` accepts an OPTIONAL
 * session id, but both run bare, which is why they are palette-eligible. The
 * arg-taking commands (`/model`, `/export`, `/rename`, `/queue`, `/steer`,
 * `/branch`, `/fork`, `/clone`, `/session`, `/new`, `/clear`, `/trust`,
 * `/approval`) and the display-only history commands (`/undo`, `/redo`) stay in
 * the `/`-menu only.
 */
export const PALETTE_SLASH_NAMES: ReadonlySet<string> = new Set<string>([
    'exit',
    'help',
    'hotkeys',
    'compact',
    'continue',
    'interrupt',
    'resume',
    'sessions',
    'tree',
]);

/**
 * Every base command name appearing in `slashCommandChoices` (the full slash
 * menu). Used as the coverage universe: every name here MUST be classifiable,
 * and the registry-slash / parsechatline-only buckets partition it.
 */
export const ALL_SLASH_BASE_NAMES: ReadonlySet<string> = new Set<string>(
    slashCommandChoices.map((choice) => slashBaseName(choice.id)),
);

/**
 * Classify a slash command base name. Registry-slash commands surface in the
 * palette; parsechatline-only commands stay in the `/`-menu. Unknown names
 * classify as parsechatline-only (never palette-eligible, never throws) so a
 * stray/typo name can never accidentally surface in the palette.
 */
export function classifySlashCommand(baseName: string): SlashCommandClassification {
    return PALETTE_SLASH_NAMES.has(baseName) ? 'registry-slash' : 'parsechatline-only';
}

/** True iff `baseName` is an argument-less, palette-eligible slash command. */
export function isPaletteSlashCommand(baseName: string): boolean {
    return PALETTE_SLASH_NAMES.has(baseName);
}

/**
 * The palette-eligible slash commands with display + description, sourced from
 * `slashCommandChoices`. Sorted by slash name for deterministic rendering. A
 * name with no matching `slashCommandChoices` entry (a phantom) is skipped
 * rather than surfacing a blank description.
 */
export function getPaletteSlashCommands(): readonly PaletteSlashEntry[] {
    const entries: PaletteSlashEntry[] = [];
    for (const name of [...PALETTE_SLASH_NAMES].sort()) {
        const choice = slashCommandChoices.find((candidate) => slashBaseName(candidate.id) === name);
        if (choice === undefined) continue;
        entries.push({
            slashName: name,
            display: `/${name}`,
            description: choice.description,
        });
    }
    return entries;
}
