/**
 * Message undo/redo keymap layer (T15).
 *
 * Registers `messages.undo` (`<leader>u`) and `messages.redo` (`<leader>r`) as
 * a SESSION-scoped keymap layer that is NOT textarea-gated (the `<leader>`
 * chords have no higher-priority binding, so they fire regardless of input
 * focus — same posture as the rest of the messages.* layer, T10).
 *
 * NON-DESTRUCTIVE by design. Undo hides the last complete user/assistant
 * exchange from the live VIEW only. ChatStore owns the single-level stash and
 * keeps `outputText` + typed `transcriptParts` aligned. The durable session
 * store is NEVER touched. The durable `/fork`/`/branch` path remains the
 * persistent alternative.
 *
 * SINGLE-LEVEL. At most one exchange is hidden at a time. A second undo while
 * one is already hidden is a no-op; redo clears the single stash slot.
 *
 * Module-graph safety: imports only `@opentui/keymap` types (erased at compile
 * time), the pure-data `keybind.ts` registry, and the pure extraction helpers
 * in `state/message-exchange`. NO `@opentui/core`. Dynamically imported by the
 * App keymap layers so `--no-tui` stays clean.
 */

import type { Command, Keymap, KeymapEvent } from '@opentui/keymap';
import {
    extractLastExchange,
    type ExtractedExchange,
    reinsertExchange,
} from '../../state/message-exchange';
import { CommandMap, commandBindings, type InputBinding, type KeybindName, Keybinds } from './keybind';

export type { ExtractedExchange };
export { extractLastExchange, reinsertExchange };

// ---------------------------------------------------------------------------
// Config-driven bindings (sourced from the keybind.ts registry)
// ---------------------------------------------------------------------------

const MESSAGE_UNDO_REDO_BINDINGS = ['messages_undo', 'messages_redo'] as const satisfies readonly KeybindName[];

/**
 * Build the chord→command bindings for the two undo/redo commands from the
 * keybind.ts registry (config-driven, rebindable via T17 overrides). Both
 * defaults are `<leader>`-prefixed (`<leader>u`, `<leader>r`); the leader token
 * is resolved at the keymap level by `registerTimedLeader` (T7).
 */
export function messageUndoRedoBindings(
    keybinds: ReturnType<typeof Keybinds.parse> = Keybinds.parse({}),
): readonly InputBinding[] {
    return MESSAGE_UNDO_REDO_BINDINGS.flatMap((name) => commandBindings(keybinds, name));
}

// ---------------------------------------------------------------------------
// Dependencies injected by App keymap layers (kept decoupled from internals)
// ---------------------------------------------------------------------------

export interface MessageUndoRedoDeps {
    /** Hide/restore last exchange keeping typed + legacy projections aligned. */
    readonly undoLastViewExchange: () => 'ok' | 'generating' | 'empty' | 'already' | 'blocked';
    readonly redoLastViewExchange: () => 'ok' | 'generating' | 'empty' | 'blocked';
    /** Surface a one-line notice (bridge.emitOutput). */
    readonly emitNotice: (text: string) => void;
    /** Optional gate; default true. Overlay hosts pass overlayMode === 'none'. */
    readonly isEnabled?: () => boolean;
}

// ---------------------------------------------------------------------------
// Layer registration
// ---------------------------------------------------------------------------

/**
 * Same negative priority as the rest of the messages.* layer (T10) and the
 * session-shortcuts layer (T12): below the managed textarea layer (priority 0).
 * The `<leader>u`/`<leader>r` chords have no higher-priority binding, so they
 * fire regardless of textarea focus.
 */
export const MESSAGE_UNDO_REDO_LAYER_PRIORITY = -100;

/**
 * Register the messages.undo / messages.redo layer onto `keymap`. Generic over
 * the keymap's target/event types so a real `Keymap<Renderable, KeyEvent>` and
 * a test `Keymap<TestKeymapTarget, TestKeymapEvent>` both satisfy it without
 * casts (same pattern as `registerMessagesScrollLayer`, T10).
 *
 * Returns the layer disposer. SESSION-scoped; optional isEnabled gates the
 * layer while overlays own the screen. Stash ownership lives on ChatStore so
 * typed + legacy stay dual-consistent.
 */
export function registerMessageUndoRedoLayer<TTarget extends object, TEvent extends KeymapEvent>(
    keymap: Keymap<TTarget, TEvent>,
    deps: MessageUndoRedoDeps,
): () => void {
    const commands: readonly Command<TTarget, TEvent>[] = [
        {
            name: CommandMap.messages_undo,
            desc: 'Undo last message exchange',
            run: () => {
                const result = deps.undoLastViewExchange();
                if (result === 'blocked') {
                    deps.emitNotice('Cannot undo while an overlay is open.\n');
                    return false;
                }
                if (result === 'generating') {
                    deps.emitNotice('Cannot undo while generating.\n');
                    return false;
                }
                if (result === 'already') {
                    deps.emitNotice('Nothing more to undo. Press leader+r to restore.\n');
                    return false;
                }
                if (result === 'empty') {
                    deps.emitNotice('Nothing to undo.\n');
                    return false;
                }
                deps.emitNotice('Reverted last exchange. Press leader+r to restore.\n');
                return true;
            },
        },
        {
            name: CommandMap.messages_redo,
            desc: 'Redo last undone message exchange',
            run: () => {
                const result = deps.redoLastViewExchange();
                if (result === 'blocked') {
                    deps.emitNotice('Cannot redo while an overlay is open.\n');
                    return false;
                }
                if (result === 'generating') {
                    deps.emitNotice('Cannot redo while generating.\n');
                    return false;
                }
                if (result === 'empty') {
                    deps.emitNotice('Nothing to redo.\n');
                    return false;
                }
                deps.emitNotice('Restored exchange.\n');
                return true;
            },
        },
    ];

    return keymap.registerLayer({
        priority: MESSAGE_UNDO_REDO_LAYER_PRIORITY,
        enabled: () => deps.isEnabled?.() ?? true,
        commands,
        bindings: messageUndoRedoBindings(),
    });
}
