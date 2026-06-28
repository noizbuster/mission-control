/**
 * Messages scroll + copy-message keymap layer (T10).
 *
 * Registers fine-grained scroll commands (line / half-page / first / last) and
 * a copy-last-assistant-message command as a SESSION-level keymap layer that is
 * NOT textarea-gated (unlike input.* from T3/T4). These act on the transcript
 * scrollbox and clipboard regardless of whether the chat textarea is focused.
 *
 * Chord collision resolution (T2 learnings note 66): messages.first
 * (ctrl+shift+home) and messages.last (ctrl+shift+end) share their first chord
 * with input.buffer.home / input.buffer.end. The messages layer sits at a LOWER
 * priority than the managed textarea layer (T3, default priority 0), so when the
 * textarea is focused the input.* cursor-movement commands win, and when it is
 * not the messages.* scroll commands win. Non-colliding chords (ctrl+alt+y/e/u/d,
 * <leader>y) fire regardless of textarea focus because no higher-priority layer
 * binds them — the keymap continues to lower-priority layers for unbound chords.
 *
 * The existing Home/End/PgUp/PgDn branches in bridgeTextareaKeyDown stay (bare
 * keys); T10 ADDS finer-grained ctrl+alt/ctrl+shift chords alongside them.
 *
 * Module-graph safety: imports only @opentui/keymap types (erased at compile
 * time) and the pure-data keybind.ts registry. NO @opentui/core. Dynamically
 * imported by the opentui bridge (TUI path only) so --no-tui stays clean.
 */

import type { Command, Keymap, KeymapEvent } from '@opentui/keymap';
import type { ClipboardService } from '../clipboard-service.js';
import { CommandMap, expandToChords, type InputBinding, type KeybindName, Keybinds } from './keybind.js';

// ---------------------------------------------------------------------------
// Structural ports (keep the module FFI-free and unit-testable)
// ---------------------------------------------------------------------------

/**
 * Minimal scrollbox surface the scroll commands drive. Structurally compatible
 * with opentui's `ScrollBoxRenderable` and the recording scrollbox used in tests.
 */
export interface ScrollboxLike {
    scrollTo(target: number | { readonly x?: number; readonly y?: number }): void;
    scrollBy(delta: number | { readonly x?: number; readonly y?: number }): void;
    readonly scrollHeight: number;
}

/** A ref-like handle to a nullable scrollbox (matches React.RefObject shape). */
export interface ScrollboxRef {
    readonly current: ScrollboxLike | null;
}

/** Dependencies injected by the bridge ChatRoot (kept decoupled from bridge internals). */
export interface MessagesScrollDeps {
    readonly scrollboxRef: ScrollboxRef;
    readonly clipboardService: ClipboardService;
    /** Returns the last `Assistant:` block text; empty when none exists. */
    readonly getLastAssistantText: () => string;
}

// ---------------------------------------------------------------------------
// Terminal-rows helper
// ---------------------------------------------------------------------------

const DEFAULT_TERMINAL_ROWS = 24;

function terminalRows(): number {
    return process.stdout.rows ?? DEFAULT_TERMINAL_ROWS;
}

/**
 * Half-page scroll delta: `floor(rows / 2)`. Mirrors the existing PgUp/PgDn
 * branch in `bridgeTextareaKeyDown` so half-page scroll is consistent with
 * full-page scroll. Exported as a pure function for deterministic unit testing.
 */
export function halfPageScrollDelta(rows: number): number {
    return Math.floor(rows / 2);
}

// ---------------------------------------------------------------------------
// Config-driven bindings (sourced from the keybind.ts registry)
// ---------------------------------------------------------------------------

/**
 * The 7 messages.* commands T10 owns. messages.page.up/down (bare pageup/
 * pagedown) stay on the existing bridgeTextareaKeyDown handlers; messages.undo/
 * messages.redo are deferred. Listed explicitly so the SET of commands is
 * clear even as the chords remain rebindable via keybind.ts.
 */
const MESSAGES_SCROLL_BINDINGS = [
    'messages_line_up',
    'messages_line_down',
    'messages_half_page_up',
    'messages_half_page_down',
    'messages_first',
    'messages_last',
    'messages_copy',
] as const satisfies readonly KeybindName[];

/**
 * Build the chord→command bindings for the 7 messages.* scroll/copy commands
 * from the keybind.ts registry (config-driven, rebindable via T17 overrides).
 * Multi-chord values like `'ctrl+shift+end,end'` expand to separate bindings
 * (comma = alternatives via registerCommaBindings, T7).
 */
export function messagesScrollBindings(
    keybinds: ReturnType<typeof Keybinds.parse> = Keybinds.parse({}),
): readonly InputBinding[] {
    const result: InputBinding[] = [];
    for (const name of MESSAGES_SCROLL_BINDINGS) {
        const cmd = CommandMap[name];
        if (cmd === undefined) continue;
        for (const chord of expandToChords(keybinds[name])) {
            result.push({ key: chord, cmd });
        }
    }
    return result;
}

// ---------------------------------------------------------------------------
// Layer registration
// ---------------------------------------------------------------------------

/**
 * Priority for the messages.* scroll layer. Negative so the managed textarea
 * layer (T3, default priority 0) wins ties on the colliding chords
 * (ctrl+shift+home, ctrl+shift+end) when the textarea is focused — cursor
 * movement takes priority while editing, scroll takes priority otherwise.
 */
export const MESSAGES_SCROLL_LAYER_PRIORITY = -100;

/**
 * Register the messages.* scroll + copy layer onto `keymap`. Generic over the
 * keymap's target/event types so a real `Keymap<Renderable, KeyEvent>` and a
 * test `Keymap<TestKeymapTarget, TestKeymapEvent>` both satisfy it without casts
 * (same pattern as `registerLeaderAddons`, T7).
 *
 * Returns the layer disposer. The layer is SESSION-scoped (`enabled: () => true`
 * within the ChatRoot mount = session active) and NOT textarea-gated, so the
 * scroll/copy chords fire whether or not the chat input is focused.
 */
export function registerMessagesScrollLayer<TTarget extends object, TEvent extends KeymapEvent>(
    keymap: Keymap<TTarget, TEvent>,
    deps: MessagesScrollDeps,
    options: { readonly isEnabled?: () => boolean } = {},
): () => void {
    const { scrollboxRef, clipboardService, getLastAssistantText } = deps;

    const commands: readonly Command<TTarget, TEvent>[] = [
        {
            name: 'messages.line.up',
            desc: 'Scroll messages up by one line',
            run: () => {
                scrollboxRef.current?.scrollBy(-1);
                return true;
            },
        },
        {
            name: 'messages.line.down',
            desc: 'Scroll messages down by one line',
            run: () => {
                scrollboxRef.current?.scrollBy(1);
                return true;
            },
        },
        {
            name: 'messages.half_page.up',
            desc: 'Scroll messages up by half page',
            run: () => {
                scrollboxRef.current?.scrollBy(-halfPageScrollDelta(terminalRows()));
                return true;
            },
        },
        {
            name: 'messages.half_page.down',
            desc: 'Scroll messages down by half page',
            run: () => {
                scrollboxRef.current?.scrollBy(halfPageScrollDelta(terminalRows()));
                return true;
            },
        },
        {
            name: 'messages.first',
            desc: 'Navigate to first message',
            run: () => {
                scrollboxRef.current?.scrollTo(0);
                return true;
            },
        },
        {
            name: 'messages.last',
            desc: 'Navigate to last message',
            run: () => {
                const bottom = scrollboxRef.current?.scrollHeight ?? 0;
                scrollboxRef.current?.scrollTo(bottom);
                return true;
            },
        },
        {
            name: 'messages.copy',
            desc: 'Copy last assistant message',
            run: () => {
                const text = getLastAssistantText();
                // No-op when no assistant message exists: no clipboard mutation.
                if (text.length === 0) return false;
                // Fire-and-forget OSC52 (mirrors selection-copy.ts pattern).
                void clipboardService.copyToClipboard(text);
                return true;
            },
        },
    ];

    return keymap.registerLayer({
        priority: MESSAGES_SCROLL_LAYER_PRIORITY,
        enabled: () => options.isEnabled?.() ?? true,
        commands,
        bindings: messagesScrollBindings(),
    });
}
