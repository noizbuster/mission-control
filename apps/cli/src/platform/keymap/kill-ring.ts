/**
 * Emacs kill-ring + yank/yank-pop + kill-on-delete keymap layer (T5).
 *
 * Ports oh-my-pi's `KillRing` (60-entry ring with consecutive-kill
 * accumulation) and wires yank (ctrl+y), yank-pop (alt+y), and kill-on-delete
 * (ctrl+w / ctrl+k / ctrl+u) as a HIGHER-PRIORITY keymap layer that shadows
 * the managed textarea layer's (T3/T4) delete bindings so the killed text is
 * captured into the ring before it is removed.
 *
 * Editor access goes through `renderer.currentFocusedEditor` (the focused
 * TextareaRenderable) — the SAME surface the addon's edit-buffer commands use.
 * insertText (yank) and setSelection/deleteSelection (yank-pop) are METHOD
 * calls: they fire the editor's `content-changed` event, so the bridge's
 * `inputBuffer` mirror stays in sync (no shadow text buffer — see T3/T13
 * learnings). This module NEVER touches the opentui-chat-bridge textareaRef.
 *
 * Capture strategy: the addon's delete methods (`deleteWordBackward` /
 * `deleteToLineEnd` / `deleteToLineStart`) do not return the deleted text, so
 * the kill commands read `plainText` + `cursorOffset` BEFORE invoking the
 * delete and AGAIN AFTER, then diff to recover the deleted text and its
 * direction (backward = cursor moved left = prepend; forward = cursor held =
 * append). This mirrors oh-my-pi's `#recordKill(text, direction)` without
 * re-implementing word/line boundary logic.
 *
 * Accumulation: oh-my-pi resets the kill-run (`lastAction = null`) on any
 * non-kill action (typing, navigation, yank). This layer can only OBSERVE
 * kill-ring actions (kill / yank / yank-pop), so it resets the kill-run on a
 * yank (the one observable non-kill action) and accumulates otherwise. Typing
 * or arrow-key navigation between two rapid kills would therefore accumulate
 * in T5 where oh-my-pi would not — a documented, accepted divergence (the
 * keymap layer cannot observe textarea typing/navigation without bridge
 * access, which is T12/T16's lane). Acceptance criterion (c) — three
 * consecutive ctrl+w into one entry — holds.
 *
 * Module-graph safety: imports ONLY `@opentui/keymap` types (erased) and the
 * pure-data `keybind.ts` registry. NO `@opentui/core` value import, so the
 * unit test runs headlessly without native FFI (mirrors T10/T13). Dynamically
 * pulled in via `keymap-managed-layer.ts`, itself lazy-imported by the bridge.
 */

import type { Command, Keymap, KeymapEvent } from '@opentui/keymap';
import { CommandMap } from './keybind.js';

// allow: SIZE_OK — the T5 FILE LANE mandates the KillRing storage AND the
// registerKillRingLayer command-layer registration live in ONE file; splitting
// would fragment a single cohesive deliverable (mirrors keybind.ts / model-
// favorites.ts / diff-viewer.tsx single-file precedents).

/** Maximum entries kept in the ring (oldest dropped). Mirrors oh-my-pi. */
export const KILL_RING_MAX_ENTRIES = 60;

// ---------------------------------------------------------------------------
// KillRing (pure storage; faithful port of oh-my-pi's packages/tui/kill-ring)
// ---------------------------------------------------------------------------

export interface KillPushOptions {
    /** When accumulating, prepend (backward deletion) or append (forward). */
    readonly prepend: boolean;
    /** Merge into the most recent entry instead of pushing a new one. */
    readonly accumulate?: boolean;
}

/**
 * Ring buffer for Emacs-style kill/yank. Tracks killed text; consecutive
 * kills can accumulate into one entry; yank returns the most recent;
 * yank-pop rotates to cycle older entries.
 */
export class KillRing {
    readonly #ring: string[] = [];

    push(text: string, opts: KillPushOptions): void {
        if (text.length === 0) return;
        if (opts.accumulate === true && this.#ring.length > 0) {
            const last = this.#ring.pop();
            this.#ring.push(opts.prepend ? text + (last ?? '') : (last ?? '') + text);
        } else {
            this.#ring.push(text);
            if (this.#ring.length > KILL_RING_MAX_ENTRIES) this.#ring.shift();
        }
    }

    /** Most recent entry, or `undefined` when empty. Does not mutate the ring. */
    peek(): string | undefined {
        return this.#ring.length > 0 ? this.#ring[this.#ring.length - 1] : undefined;
    }

    /** Move the last entry to the front (used by yank-pop to cycle). */
    rotate(): void {
        if (this.#ring.length <= 1) return;
        const last = this.#ring.pop();
        if (last !== undefined) this.#ring.unshift(last);
    }

    get length(): number {
        return this.#ring.length;
    }
}

// ---------------------------------------------------------------------------
// Structural ports (keep the module FFI-free and unit-testable)
// ---------------------------------------------------------------------------

/**
 * Minimal editor surface the kill-ring layer drives. Structurally compatible
 * with opentui's `TextareaRenderable` (via `EditBufferRenderable`) reached at
 * `renderer.currentFocusedEditor`, and with the recording editor used in tests.
 */
export interface KillRingEditor {
    readonly plainText: string;
    readonly cursorOffset: number;
    insertText(text: string): void;
    setSelection(start: number, end: number): void;
    deleteSelection(): boolean;
    deleteWordBackward(): boolean;
    deleteToLineEnd(): boolean;
    deleteToLineStart(): boolean;
}

/**
 * Minimal host surface exposing the focused editor. Structurally compatible
 * with `CliRenderer` (`currentFocusedEditor: EditBufferRenderable | null`).
 */
export interface KillRingHost {
    readonly currentFocusedEditor: unknown;
}

/** Type guard narrowing an unknown value to the editor surface (no instanceof/FFI). */
function isKillRingEditor(value: unknown): value is KillRingEditor {
    if (value === null || typeof value !== 'object') return false;
    const v = value as { insertText?: unknown; deleteWordBackward?: unknown };
    return typeof v.insertText === 'function' && typeof v.deleteWordBackward === 'function';
}

// ---------------------------------------------------------------------------
// Kill-on-delete capture (diff before/after the real delete)
// ---------------------------------------------------------------------------

type KillDirection = 'forward' | 'backward';

interface CapturedKill {
    readonly text: string;
    readonly direction: KillDirection;
}

/**
 * Run a delete op on the editor and recover the removed text + direction by
 * diffing `plainText` + `cursorOffset` before/after. Backward deletes move
 * the cursor left (the removed range is `[after, before)`); forward deletes
 * hold the cursor (the removed range starts at `beforeOffset`). Returns `null`
 * when nothing was removed.
 */
function captureDeletion(editor: KillRingEditor, run: () => void): CapturedKill | null {
    const before = editor.plainText;
    const beforeOffset = editor.cursorOffset;
    run();
    const after = editor.plainText;
    const afterOffset = editor.cursorOffset;
    if (after === before) return null;
    if (afterOffset < beforeOffset) {
        return { text: before.slice(afterOffset, beforeOffset), direction: 'backward' };
    }
    const removed = before.length - after.length;
    if (removed <= 0) return null;
    return { text: before.slice(beforeOffset, beforeOffset + removed), direction: 'forward' };
}

// ---------------------------------------------------------------------------
// Kill-ring action state (closure-held; not observable to the textarea)
// ---------------------------------------------------------------------------

interface KillRingState {
    lastWasKill: boolean;
    lastWasYank: boolean;
    lastYank: { readonly start: number; readonly length: number } | null;
}

function createState(): KillRingState {
    return { lastWasKill: false, lastWasYank: false, lastYank: null };
}

/** Push a captured kill into the ring, accumulating on a consecutive kill-run. */
function recordKill(ring: KillRing, state: KillRingState, captured: CapturedKill): void {
    if (captured.text.length === 0) return;
    ring.push(captured.text, {
        prepend: captured.direction === 'backward',
        accumulate: state.lastWasKill,
    });
    state.lastWasKill = true;
    state.lastWasYank = false;
}

/** Yank the most recent ring entry at the cursor via `insertText`. No-op if empty. */
function yank(editor: KillRingEditor, ring: KillRing, state: KillRingState): void {
    const text = ring.peek();
    if (text === undefined) return;
    const start = editor.cursorOffset;
    editor.insertText(text);
    state.lastYank = { start, length: text.length };
    state.lastWasYank = true;
    state.lastWasKill = false;
}

/** Replace the just-yanked span with the previous ring entry. No-op unless right after a yank. */
function yankPop(editor: KillRingEditor, ring: KillRing, state: KillRingState): void {
    if (!state.lastWasYank || ring.length <= 1 || state.lastYank === null) return;
    const span = state.lastYank;
    editor.setSelection(span.start, span.start + span.length);
    editor.deleteSelection();
    ring.rotate();
    const prev = ring.peek();
    if (prev !== undefined) {
        editor.insertText(prev);
        state.lastYank = { start: span.start, length: prev.length };
    }
    // lastWasYank stays true so alt+y can cycle again.
}

// ---------------------------------------------------------------------------
// Command ids (yank/yank-pop from the registry; kill commands layer-local)
// ---------------------------------------------------------------------------

/** Kill command ids. Layer-local (shadow the managed layer's `input.delete.*`). */
const KILL_WORD_BACKWARD_CMD = 'input.kill.word_backward';
const KILL_TO_LINE_END_CMD = 'input.kill.to_line_end';
const KILL_TO_LINE_START_CMD = 'input.kill.to_line_start';

type ResolveEditor = () => KillRingEditor | null;
type DeleteOp = (editor: KillRingEditor) => void;

function makeKillCommand<TTarget extends object, TEvent extends KeymapEvent>(
    name: string,
    desc: string,
    resolve: ResolveEditor,
    ring: KillRing,
    state: KillRingState,
    deleteOp: DeleteOp,
): Command<TTarget, TEvent> {
    return {
        name,
        desc,
        run: () => {
            const editor = resolve();
            if (editor !== null) {
                const captured = captureDeletion(editor, () => deleteOp(editor));
                if (captured !== null) recordKill(ring, state, captured);
            }
            return true;
        },
    };
}

/** Layer priority. Above the managed textarea layer (T3, priority 0) so the
 *  kill-ring's ctrl+w/k/u shadow the managed `input.delete.*` bindings, and
 *  ctrl+y/alt+y win as clean additions. Same band as the submit layer (T3). */
export const KILL_RING_LAYER_PRIORITY = 100;

export interface RegisterKillRingLayerOptions {
    /** Focus gate; defaults to "a structurally editor-like target is focused". */
    readonly hasFocus?: () => boolean;
    /** Inject a ring (tests); the layer owns its own ring when omitted. */
    readonly ring?: KillRing;
}

/**
 * Register the kill-ring keymap layer. Generic over the keymap's target/event
 * types so a real `Keymap<Renderable, KeyEvent>` and a test
 * `Keymap<TestKeymapTarget, TestKeymapEvent>` both satisfy it (T7/T10 pattern).
 *
 * Returns the layer disposer. The caller (the managed-textarea composition)
 * passes `hasManagedTextareaFocus` as `hasFocus`; the default structural gate
 * is a fallback for standalone use.
 */
export function registerKillRingLayer<TTarget extends object, TEvent extends KeymapEvent>(
    keymap: Keymap<TTarget, TEvent>,
    host: KillRingHost,
    options?: RegisterKillRingLayerOptions,
): () => void {
    const ring = options?.ring ?? new KillRing();
    const state = createState();
    const hasFocus = options?.hasFocus ?? (() => isKillRingEditor(host.currentFocusedEditor));

    const resolve = (): KillRingEditor | null => {
        const editor = host.currentFocusedEditor;
        return isKillRingEditor(editor) ? editor : null;
    };

    const commands: readonly Command<TTarget, TEvent>[] = [
        {
            name: CommandMap.input_yank,
            desc: 'Yank (paste) from kill ring',
            run: () => {
                const editor = resolve();
                if (editor !== null) yank(editor, ring, state);
                return true;
            },
        },
        {
            name: CommandMap.input_yank_pop,
            desc: 'Yank-pop (cycle kill ring)',
            run: () => {
                const editor = resolve();
                if (editor !== null) yankPop(editor, ring, state);
                return true;
            },
        },
        makeKillCommand(KILL_WORD_BACKWARD_CMD, 'Kill word backward', resolve, ring, state, (e) =>
            e.deleteWordBackward(),
        ),
        makeKillCommand(KILL_TO_LINE_END_CMD, 'Kill to end of line', resolve, ring, state, (e) => e.deleteToLineEnd()),
        makeKillCommand(KILL_TO_LINE_START_CMD, 'Kill to start of line', resolve, ring, state, (e) =>
            e.deleteToLineStart(),
        ),
    ];

    return keymap.registerLayer({
        priority: KILL_RING_LAYER_PRIORITY,
        enabled: () => hasFocus(),
        commands,
        bindings: [
            { key: 'ctrl+y', cmd: CommandMap.input_yank },
            { key: 'alt+y', cmd: CommandMap.input_yank_pop },
            { key: 'ctrl+w', cmd: KILL_WORD_BACKWARD_CMD },
            { key: 'ctrl+k', cmd: KILL_TO_LINE_END_CMD },
            { key: 'ctrl+u', cmd: KILL_TO_LINE_START_CMD },
        ],
    });
}
