/**
 * mctrl rebindable keybind config registry (T2).
 *
 * Pure data/config module: it owns the Definitions table, the command-id map,
 * and the `parse`/`unknownKeys`/`bindingDefaults` helpers. It does NOT touch a
 * keymap instance and has zero runtime side effects. T3 (managed textarea
 * layer), T7 (leader config), and T8 (palette) consume this registry to build
 * their keymap layers and cheat-sheet views.
 *
 * Ports opencode's `tui/src/config/keybind.ts` pattern (Definitions /
 * CommandMap / Keybinds.parse / unknownKeys / bindingDefaults) but TAILORED to
 * mctrl: mctrl's documented chords are preserved as defaults, palette is Alt+X
 * (NOT Ctrl+P — Ctrl+P stays model-cycle), and the input namespace deliberately
 * EXCLUDES `input_clear`/`ctrl+c` so the Ctrl+C interrupt/exit contract keeps
 * routing through the global useKeyboard sink (apps/cli/AGENTS.md anti-pattern:
 * "Do NOT add a Ctrl+C copy regime").
 *
 * No `effect` (opencode is effect-Schema; mctrl uses plain TS here). No
 * `solid-js`. The `Renderable`/`KeyEvent`/`BindingDefaults` imports are
 * type-only (erased at compile time) so this module never loads the native FFI
 * backend.
 */

import type { KeyEvent, Renderable } from '@opentui/core';
import type { BindingCommandMap, BindingDefaults } from '@opentui/keymap/extras';

/** Default leader key. `<leader>` resolves to this at runtime (T7 registerTimedLeader). */
export const LeaderDefault = 'ctrl+x';

/** A single key stroke spec (matches opencode's KeyStroke / extras KeyLike shape). */
export interface KeyStroke {
    readonly name: string;
    readonly ctrl?: boolean;
    readonly shift?: boolean;
    readonly meta?: boolean;
    readonly super?: boolean;
    readonly hyper?: boolean;
}

/** A binding object: a key plus event/preventDefault/fallthrough flags. */
export interface BindingObject {
    readonly key: string | KeyStroke;
    readonly event?: 'press' | 'release';
    readonly preventDefault?: boolean;
    readonly fallthrough?: boolean;
}

export type BindingItem = string | KeyStroke | BindingObject;

/**
 * A binding value: a chord string (`"ctrl+p"`), a multi-chord string
 * (`"ctrl+c,ctrl+d,<leader>q"`), a stroke/object spec, an array of specs,
 * `false` (disabled), or `"none"` (disabled — in catalog but unbound). The
 * `"none"` form lets a command stay in the registry (so `/hotkeys` lists it and
 * users can rebind it) without a default chord.
 */
export type BindingValue = false | 'none' | BindingItem | readonly BindingItem[];

interface Definition {
    readonly default: BindingValue;
    readonly description: string;
}

const keybind = (defaultValue: BindingValue, description: string): Definition => ({
    default: defaultValue,
    description,
});

/**
 * The mctrl keybind catalog. Each entry pairs a default binding value with a
 * human description. Names are grouped by namespace (app/session/model/input/...)
 * but the object is flat so `parse`/`unknownKeys` stay O(1) per key.
 *
 * INVARIANTS (enforced by tests):
 *  - `leader === "ctrl+x"`.
 *  - `command_list === "alt+x"` (palette is NOT Ctrl+P; Ctrl+P is model_cycle).
 *  - No `input_clear` entry; no `input_*` value binds bare `ctrl+c`.
 *  - mctrl-documented chords preserved: ctrl+p/t/o/e/r/v/g/z.
 */
export const Definitions = {
    leader: keybind(LeaderDefault, 'Leader key for keybind combinations'),

    // app / global actions
    command_list: keybind('alt+x', 'Open command palette'),
    session_interrupt: keybind('escape', 'Interrupt current session'),
    terminal_suspend: keybind('ctrl+z', 'Suspend terminal'),
    clipboard_paste_image: keybind('ctrl+v', 'Paste image from clipboard'),
    editor_open: keybind('ctrl+e', 'Open external editor'),
    session_rename: keybind('ctrl+r', 'Rename session'),
    abg_overlay_toggle: keybind('ctrl+g', 'Toggle ABG monitoring overlay'),
    thinking_toggle: keybind('ctrl+t', 'Toggle thinking/reasoning display'),
    tool_expand: keybind('ctrl+o', 'Toggle tool output expand/collapse'),
    tips_toggle: keybind('<leader>h', 'Toggle tips'),

    // model
    model_cycle: keybind('ctrl+p', 'Cycle to next model'),
    model_cycle_reverse: keybind('shift+ctrl+p', 'Cycle to previous model'),
    model_cycle_recent: keybind('f2', 'Next recently used model'),
    model_cycle_recent_reverse: keybind('shift+f2', 'Previous recently used model'),
    model_list: keybind('<leader>m', 'List available models'),
    model_quick_switch_1: keybind('<leader>1', 'Switch to favorited model slot 1'),
    model_quick_switch_2: keybind('<leader>2', 'Switch to favorited model slot 2'),
    model_quick_switch_3: keybind('<leader>3', 'Switch to favorited model slot 3'),
    model_quick_switch_4: keybind('<leader>4', 'Switch to favorited model slot 4'),
    model_quick_switch_5: keybind('<leader>5', 'Switch to favorited model slot 5'),
    model_quick_switch_6: keybind('<leader>6', 'Switch to favorited model slot 6'),
    model_quick_switch_7: keybind('<leader>7', 'Switch to favorited model slot 7'),
    model_quick_switch_8: keybind('<leader>8', 'Switch to favorited model slot 8'),
    model_quick_switch_9: keybind('<leader>9', 'Switch to favorited model slot 9'),

    // agent
    agent_list: keybind('<leader>a', 'List agents'),

    // session
    session_new: keybind('<leader>n', 'Create a new session'),
    session_list: keybind('<leader>l', 'List all sessions'),
    session_compact: keybind('<leader>c', 'Compact the session'),
    session_export: keybind('<leader>x', 'Export session to editor'),
    session_timeline: keybind('<leader>g', 'Show session timeline'),
    session_queued_prompts: keybind('<leader>q', 'Manage queued prompts'),

    // messages scroll + nav
    messages_page_up: keybind('pageup', 'Scroll messages up by one page'),
    messages_page_down: keybind('pagedown', 'Scroll messages down by one page'),
    messages_line_up: keybind('ctrl+alt+y', 'Scroll messages up by one line'),
    messages_line_down: keybind('ctrl+alt+e', 'Scroll messages down by one line'),
    messages_half_page_up: keybind('ctrl+alt+u', 'Scroll messages up by half page'),
    messages_half_page_down: keybind('ctrl+alt+d', 'Scroll messages down by half page'),
    messages_first: keybind('ctrl+shift+home', 'Navigate to first message'),
    messages_last: keybind('ctrl+shift+end,end', 'Navigate to last message'),
    messages_undo: keybind('<leader>u', 'Undo last message exchange'),
    messages_redo: keybind('<leader>r', 'Redo last undone message exchange'),
    messages_copy: keybind('<leader>y', 'Copy last assistant message'),

    // which-key
    which_key_toggle: keybind('ctrl+alt+k', 'Toggle which-key panel'),
    which_key_layout_toggle: keybind('ctrl+alt+shift+k', 'Switch which-key layout'),

    // input editing (textarea). NOTE: no input_clear / no ctrl+c.
    // input_line_end is ctrl+shift+e (ctrl+e is reserved for editor_open).
    // input_buffer_home/end are ctrl+shift+home/end (bare home/end scroll transcript).
    input_move_left: keybind('left,ctrl+b', 'Move cursor left in input'),
    input_move_right: keybind('right,ctrl+f', 'Move cursor right in input'),
    input_move_up: keybind('up', 'Move cursor up in input'),
    input_move_down: keybind('down', 'Move cursor down in input'),
    input_select_left: keybind('shift+left', 'Select left in input'),
    input_select_right: keybind('shift+right', 'Select right in input'),
    input_select_up: keybind('shift+up', 'Select up in input'),
    input_select_down: keybind('shift+down', 'Select down in input'),
    input_line_home: keybind('ctrl+a', 'Move to start of line in input'),
    input_line_end: keybind('ctrl+shift+e', 'Move to end of line in input'),
    input_buffer_home: keybind('ctrl+shift+home', 'Move to start of buffer in input'),
    input_buffer_end: keybind('ctrl+shift+end', 'Move to end of buffer in input'),
    input_delete_line: keybind('ctrl+shift+d', 'Delete line in input'),
    input_delete_to_line_start: keybind('ctrl+u', 'Delete to start of line in input'),
    input_delete_to_line_end: keybind('ctrl+k', 'Delete to end of line in input'),
    input_backspace: keybind('backspace,shift+backspace', 'Backspace in input'),
    input_delete: keybind('ctrl+d,delete', 'Delete character in input'),
    input_undo: keybind('ctrl+-', 'Undo in input'),
    input_redo: keybind('ctrl+.', 'Redo in input'),
    input_word_forward: keybind('alt+f,alt+right,ctrl+right', 'Move word forward in input'),
    input_word_backward: keybind('alt+b,alt+left,ctrl+left', 'Move word backward in input'),
    input_delete_word_forward: keybind('alt+d,alt+delete,ctrl+delete', 'Delete word forward in input'),
    input_delete_word_backward: keybind('ctrl+w,ctrl+backspace,alt+backspace', 'Delete word backward in input'),
    // select / visual variants (T4: fills gaps — native edit-buffer defaults
    // ported to the registry so the full input.* set is rebindable).
    // input_select_line_end is 'none' because ctrl+shift+e is input_line_end.
    input_select_line_home: keybind('ctrl+shift+a', 'Select to start of line in input'),
    input_select_line_end: keybind('none', 'Select to end of line in input (ctrl+shift+e is line-end)'),
    input_visual_line_home: keybind('meta+a,super+left', 'Move to visual line start in input'),
    input_visual_line_end: keybind('meta+e,super+right', 'Move to visual line end in input'),
    input_select_visual_line_home: keybind('meta+shift+a,super+shift+left', 'Select to visual line start in input'),
    input_select_visual_line_end: keybind('meta+shift+e,super+shift+right', 'Select to visual line end in input'),
    input_select_buffer_home: keybind('shift+home,super+shift+up', 'Select to buffer start in input'),
    input_select_buffer_end: keybind('shift+end,super+shift+down', 'Select to buffer end in input'),
    input_select_word_forward: keybind('meta+shift+f,meta+shift+right', 'Select word forward in input'),
    input_select_word_backward: keybind('meta+shift+b,meta+shift+left', 'Select word backward in input'),
    input_select_all: keybind('none', 'Select all in input (unbound by default; collides with ctrl+a line-home)'),
    input_submit: keybind('return', 'Submit input'),
    input_newline: keybind('shift+return,ctrl+return,alt+return,ctrl+j', 'Insert newline in input'),
    // emacs kill-ring (T5): the kill-ring layer intercepts ctrl+w/k/u (which
    // otherwise hit input.delete.*) to capture killed text, then serves it
    // back via ctrl+y/alt+y. See apps/cli/src/platform/keymap/kill-ring.ts.
    input_yank: keybind('ctrl+y', 'Yank (paste) from kill ring'),
    input_yank_pop: keybind('alt+y', 'Yank-pop (cycle kill ring)'),
} satisfies Record<string, Definition>;

export type KeybindName = keyof typeof Definitions;

const KeybindNames = new Set<string>(Object.keys(Definitions));

/** Human descriptions keyed by keybind name. */
export const Descriptions = Object.fromEntries(
    Object.entries(Definitions).map(([name, item]) => [name, item.description]),
) as Record<KeybindName, string>;

/**
 * Maps each keybind name to its dispatch command id. `leader` is intentionally
 * absent: it is a binding token, not a dispatchable command. T8 (palette) and
 * T3 (layer registration) resolve chords -> command ids through this map.
 */
export const CommandMap = {
    command_list: 'command.palette.show',
    session_interrupt: 'session.interrupt',
    terminal_suspend: 'terminal.suspend',
    clipboard_paste_image: 'clipboard.paste_image',
    editor_open: 'editor.open',
    session_rename: 'session.rename',
    abg_overlay_toggle: 'abg.overlay.toggle',
    thinking_toggle: 'display.thinking.toggle',
    tool_expand: 'tool.expand.toggle',
    tips_toggle: 'tips.toggle',
    model_cycle: 'model.cycle',
    model_cycle_reverse: 'model.cycle.reverse',
    model_cycle_recent: 'model.cycle_recent',
    model_cycle_recent_reverse: 'model.cycle_recent.reverse',
    model_list: 'model.list',
    model_quick_switch_1: 'model.quick_switch.1',
    model_quick_switch_2: 'model.quick_switch.2',
    model_quick_switch_3: 'model.quick_switch.3',
    model_quick_switch_4: 'model.quick_switch.4',
    model_quick_switch_5: 'model.quick_switch.5',
    model_quick_switch_6: 'model.quick_switch.6',
    model_quick_switch_7: 'model.quick_switch.7',
    model_quick_switch_8: 'model.quick_switch.8',
    model_quick_switch_9: 'model.quick_switch.9',
    agent_list: 'agent.list',
    session_new: 'session.new',
    session_list: 'session.list',
    session_compact: 'session.compact',
    session_export: 'session.export',
    session_timeline: 'session.timeline',
    session_queued_prompts: 'session.queued_prompts',
    messages_page_up: 'messages.page.up',
    messages_page_down: 'messages.page.down',
    messages_line_up: 'messages.line.up',
    messages_line_down: 'messages.line.down',
    messages_half_page_up: 'messages.half_page.up',
    messages_half_page_down: 'messages.half_page.down',
    messages_first: 'messages.first',
    messages_last: 'messages.last',
    messages_undo: 'messages.undo',
    messages_redo: 'messages.redo',
    messages_copy: 'messages.copy',
    which_key_toggle: 'which-key.toggle',
    which_key_layout_toggle: 'which-key.layout.toggle',
    input_move_left: 'input.move.left',
    input_move_right: 'input.move.right',
    input_move_up: 'input.move.up',
    input_move_down: 'input.move.down',
    input_select_left: 'input.select.left',
    input_select_right: 'input.select.right',
    input_select_up: 'input.select.up',
    input_select_down: 'input.select.down',
    input_line_home: 'input.line.home',
    input_line_end: 'input.line.end',
    input_buffer_home: 'input.buffer.home',
    input_buffer_end: 'input.buffer.end',
    input_delete_line: 'input.delete.line',
    input_delete_to_line_start: 'input.delete.to_line.start',
    input_delete_to_line_end: 'input.delete.to_line.end',
    input_backspace: 'input.backspace',
    input_delete: 'input.delete',
    input_undo: 'input.undo',
    input_redo: 'input.redo',
    input_word_forward: 'input.word.forward',
    input_word_backward: 'input.word.backward',
    input_delete_word_forward: 'input.delete.word.forward',
    input_delete_word_backward: 'input.delete.word.backward',
    input_select_all: 'input.select.all',
    input_select_line_home: 'input.select.line.home',
    input_select_line_end: 'input.select.line.end',
    input_visual_line_home: 'input.visual.line.home',
    input_visual_line_end: 'input.visual.line.end',
    input_select_visual_line_home: 'input.select.visual.line.home',
    input_select_visual_line_end: 'input.select.visual.line.end',
    input_select_buffer_home: 'input.select.buffer.home',
    input_select_buffer_end: 'input.select.buffer.end',
    input_select_word_forward: 'input.select.word.forward',
    input_select_word_backward: 'input.select.word.backward',
    input_submit: 'input.submit',
    input_newline: 'input.newline',
    input_yank: 'input.yank',
    input_yank_pop: 'input.yank_pop',
} satisfies BindingCommandMap;

/** Human descriptions keyed by command id (reverse-derived from CommandMap). */
const CommandDescriptions = Object.fromEntries(
    Object.entries(Definitions).map(([name, item]) => [
        CommandMap[name as keyof typeof CommandMap] ?? name,
        item.description,
    ]),
) as Record<string, string>;

export type Keybinds = { readonly [K in KeybindName]: BindingValue };
export type KeybindOverrides = Partial<Keybinds>;

/** Return the unknown (not-in-Definitions) keys of an override object. */
export function unknownKeys(input: object): string[] {
    return Object.keys(input).filter((key) => !KeybindNames.has(key));
}

/** Return the catalog default for a keybind name. */
export function defaultValue(name: KeybindName): BindingValue {
    return Definitions[name].default;
}

/**
 * Validate a value is a legal BindingValue; throw on malformed input. Replaces
 * opencode's `Schema.decodeUnknownSync(BindingValueSchema)` without `effect`.
 * Layering: the registry rejects obviously-wrong SCHEMA shapes (numbers, null,
 * booleans, etc.); the keymap compilation layer later rejects semantically
 * invalid chords. A malformed config file thus fails loudly at load, not
 * silently as a dead binding.
 */
function decodeBindingValue(value: unknown, name: string): BindingValue {
    if (value === false || value === 'none' || typeof value === 'string') return value;
    if (Array.isArray(value)) {
        return value.map((item, index) => decodeBindingValue(item, `${name}[${index}]`)) as readonly BindingItem[];
    }
    if (value === null || typeof value !== 'object') {
        throw new Error(
            `Invalid keybind value for '${name}': expected string, KeyStroke, BindingObject, array, false, or "none"`,
        );
    }
    return value as BindingItem;
}

/**
 * Merge user overrides onto the catalog defaults. Throws
 * `Unrecognized keybind(s): <list>` (singular/plural) if any override key is
 * not in Definitions. Each value is validated via `decodeBindingValue` so a
 * malformed override fails loudly.
 */
export function parse(overrides: KeybindOverrides): Keybinds {
    const invalid = unknownKeys(overrides);
    if (invalid.length > 0) {
        const noun = invalid.length === 1 ? 'keybind' : 'keybinds';
        throw new Error(`Unrecognized ${noun}: ${invalid.join(', ')}`);
    }
    return Object.fromEntries(
        Object.entries(Definitions).map(([name, item]) => [
            name,
            decodeBindingValue(overrides[name as KeybindName] ?? item.default, name),
        ]),
    ) as Keybinds;
}

export const Keybinds = { parse };

/**
 * Returns a `BindingDefaults<Renderable, KeyEvent>` that fills a binding's
 * `desc` field from `CommandDescriptions` when the binding does not already
 * carry one. Consumed by `createBindingLookup` (extras) so the command palette
 * and which-key panel (T8/T9) render human-readable descriptions without a
 * separate description source.
 */
export function bindingDefaults(): BindingDefaults<Renderable, KeyEvent> {
    return ({ command, binding }) => {
        const { desc: existingDesc } = binding as { readonly desc?: string };
        if (existingDesc !== undefined) return;
        const desc = CommandDescriptions[command];
        if (desc === undefined) return;
        return { desc };
    };
}

// ---------------------------------------------------------------------------
// Chord expansion (T4: config-driven input.* bindings)
// ---------------------------------------------------------------------------

const MODIFIER_ORDER = ['ctrl', 'shift', 'meta', 'super', 'hyper'] as const;

export function keyStrokeToChord(stroke: KeyStroke): string {
    const parts: string[] = [];
    for (const mod of MODIFIER_ORDER) {
        if (stroke[mod]) parts.push(mod);
    }
    parts.push(stroke.name);
    return parts.join('+');
}

function splitChordString(chord: string): string[] {
    return chord
        .split(',')
        .map((token) => token.trim())
        .filter((token): token is string => token.length > 0);
}

function bindingItemToChords(item: BindingItem): readonly string[] {
    if (typeof item === 'string') return splitChordString(item);
    const keyField = (item as { readonly key?: unknown }).key;
    if (typeof keyField === 'string') return splitChordString(keyField);
    if (keyField !== undefined) return [keyStrokeToChord(keyField as KeyStroke)];
    // No `key` field → KeyStroke (BindingObject.key is required, so this branch
    // is unreachable for BindingObject).
    return [keyStrokeToChord(item as KeyStroke)];
}

export function expandToChords(value: BindingValue): readonly string[] {
    if (value === false || value === 'none') return [];
    const items = Array.isArray(value) ? value : [value];
    return items.flatMap(bindingItemToChords);
}

export interface InputBinding {
    readonly key: string;
    readonly cmd: string;
    readonly [key: string]: unknown;
}

export function inputBindingsFromKeybinds(keybinds: Keybinds): readonly InputBinding[] {
    const result: InputBinding[] = [];
    for (const [name, value] of Object.entries(keybinds)) {
        if (!name.startsWith('input_')) continue;
        const cmd = CommandMap[name as keyof typeof CommandMap];
        if (cmd === undefined) continue;
        for (const chord of expandToChords(value)) {
            result.push({ key: chord, cmd });
        }
    }
    return result;
}
