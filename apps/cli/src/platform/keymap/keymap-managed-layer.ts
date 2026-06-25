/**
 * Managed textarea layer composition for the mctrl opentui TUI (T3/T4).
 *
 * Routes the textarea's `input.*` commands through the keymap by COMPOSING the
 * lower-level `@opentui/keymap/addons/opentui` helpers — does NOT call
 * `registerManagedTextareaLayer` (the high-level helper prepends overrides but
 * cannot remove conflicting default chords, so ctrl+e/ctrl+z/home/end would
 * always collide with the mctrl app-action layer).
 *
 * Composition:
 *   1. `registerTextareaMappingSuspension(keymap, renderer)` — suspends the
 *      focused TextareaRenderable's own keyBinding processing while a keymap
 *      layer is active. Printable text and method calls (insertText/setText/
 *      deleteChar) are unaffected by suspend.
 *   2. `registerEditBufferCommands(keymap, renderer)` — registers the
 *      edit-buffer command NAMES + default handlers (input.move.left, etc.)
 *      against `renderer.currentFocusedEditor`.
 *   3. A manual `keymap.registerLayer({ enabled, bindings: FILTEREDSET })` where
 *      FILTEREDSET is sourced CONFIG-DRIVEN from the `keybind.ts` registry
 *      (`inputBindingsFromKeybinds`) minus the chords that conflict with mctrl
 *      app actions (ctrl+e, ctrl+z, bare home/end). T17's config loader can
 *      rebind any input.* command by passing an overridden `Keybinds` object.
 *   4. A higher-priority layer with a CUSTOM submit command (`chat.submit`)
 *      that wraps `bridgeSubmit` (IME-safe double-setTimeout defer +
 *      submitting re-entrancy guard). Bind `return`/`kpenter` to this command
 *      instead of the addon default (`editor.submit()`).
 *
 * Ctrl+C invariant: the managed layer + filtered binding set MUST NOT bind
 * ctrl+c. Ctrl+C stays routed through the global `useKeyboard` sink
 * (`handleInput` -> interrupt). The keymap hooks `renderer.keyInput` keypress as
 * a SEPARATE EventEmitter listener from `useKeyboard`; Node EventEmitter fans
 * out with no stopPropagation, so Ctrl+C reaches BOTH the keymap (unbound ->
 * no-op) AND `useKeyboard` (-> interrupt).
 *
 * This module is only ever dynamically imported by the opentui bridge (the TUI
 * path) via `await import(...)`, keeping `@opentui/keymap/addons/opentui` (and
 * transitively `@opentui/core`'s native FFI) out of the `--no-tui` module graph.
 */

import type { CliRenderer, KeyEvent, Renderable } from '@opentui/core';
import { InputRenderable, TextareaRenderable } from '@opentui/core';
import type { Command, Keymap } from '@opentui/keymap';
import { registerEditBufferCommands, registerTextareaMappingSuspension } from '@opentui/keymap/addons/opentui';
import { type InputBinding, inputBindingsFromKeybinds, Keybinds } from './keybind.js';
import { resolveKeybindConfig } from './keybind-config-loader.js';
import { registerKillRingLayer } from './kill-ring.js';

// ---------------------------------------------------------------------------
// Focus gate
// ---------------------------------------------------------------------------

/**
 * True when the renderer's focused editor is a managed textarea (not a plain
 * InputRenderable). Mirrors opencode's `hasManagedTextareaFocus`. Used as the
 * `enabled` gate on both the filtered bindings layer and the submit layer so
 * they activate only while the chat textarea is focused.
 */
export function hasManagedTextareaFocus(renderer: CliRenderer): boolean {
    const editor = renderer.currentFocusedEditor;
    return editor instanceof TextareaRenderable && !(editor instanceof InputRenderable);
}

// ---------------------------------------------------------------------------
// Filtered textarea bindings
// ---------------------------------------------------------------------------

/**
 * Chords EXCLUDED from the textarea binding set because mctrl's app-action
 * layer owns them:
 *  - `ctrl+e` → external editor (app layer); line-end restored on ctrl+shift+e.
 *  - `ctrl+z` → terminal suspend (app layer); undo on ctrl+- (per T2/T6).
 *  - `home`   → transcript scroll-to-top (app layer); buffer-home on ctrl+shift+home.
 *  - `end`    → transcript scroll-to-bottom (app layer); buffer-end on ctrl+shift+end.
 *
 * Note: shift+home/shift+end (select-buffer-home/end) are NOT excluded — they
 * do not conflict with the app layer's bare home/end scroll.
 */
export const EXCLUDED_TEXTAREA_CHORDS = ['ctrl+e', 'ctrl+z', 'home', 'end'] as const;

/** A binding-like object with a string-or-stroke `key` field. */
export interface TextareaBindingLike {
    readonly key:
        | string
        | { readonly name?: string; readonly ctrl?: boolean; readonly shift?: boolean; readonly meta?: boolean };
    readonly cmd?: string;
    readonly [key: string]: unknown;
}

/**
 * Remove bindings whose `key` is in `EXCLUDED_TEXTAREA_CHORDS`. Only filters
 * string keys (the format `createDefaultTextareaBindings` produces via
 * `keyBindingToString`). Non-string keys (KeyStroke objects from overrides)
 * are left untouched — they are caller-specified and assumed intentional.
 */
export function filterTextareaBindings<T extends TextareaBindingLike>(bindings: readonly T[]): T[] {
    const excluded = new Set<string>(EXCLUDED_TEXTAREA_CHORDS);
    return bindings.filter((binding) => {
        if (typeof binding.key !== 'string') return true;
        return !excluded.has(binding.key);
    });
}

/**
 * Build the filtered textarea binding set sourced from the `keybind.ts`
 * registry (config-driven), not the fixed addon `createTextareaBindings()`.
 * Each `input_*` Definition maps to one or more `Binding` objects via
 * `CommandMap`; chords conflicting with mctrl app actions are then excluded.
 *
 * T17's config loader can rebind any input.* command by merging overrides
 * into a `Keybinds` object and passing it here — the resolved binding set
 * reflects the override immediately.
 */
export function createConfigDrivenTextareaBindings(
    keybinds: ReturnType<typeof Keybinds.parse> = Keybinds.parse({}),
): readonly InputBinding[] {
    const bindings = inputBindingsFromKeybinds(keybinds);
    return filterTextareaBindings(bindings);
}

/**
 * Alias kept for call-site compatibility with T3's registration code. Sources
 * from the keybind.ts registry (config-driven) since T4. Since T16, resolves
 * the user's `keybinds.json` overrides so the input.* layer reflects the same
 * resolved config as the leader and `/hotkeys` display.
 */
export function createFilteredTextareaBindings(): readonly InputBinding[] {
    const { keybinds } = resolveKeybindConfig();
    return createConfigDrivenTextareaBindings(keybinds);
}

// ---------------------------------------------------------------------------
// Custom submit command
// ---------------------------------------------------------------------------

/**
 * The custom submit command name. Shadows `input.submit` at a higher layer
 * priority so `return`/`kpenter` dispatch to `bridgeSubmit` (IME-safe) instead
 * of the addon default `editor.submit()`.
 */
export const CHAT_SUBMIT_COMMAND = 'chat.submit';

/**
 * Build the custom submit command. The `submitHandler` callback wraps
 * `bridgeSubmit(core, textareaRef)` — the caller provides it so this module
 * has no dependency on the bridge module (avoids a circular import).
 */
export function createChatSubmitCommand(submitHandler: () => void): Command<Renderable, KeyEvent> {
    return {
        name: CHAT_SUBMIT_COMMAND,
        desc: 'Submit chat input',
        run() {
            submitHandler();
            return true;
        },
    };
}

// ---------------------------------------------------------------------------
// Layer registration
// ---------------------------------------------------------------------------

/**
 * Register the managed textarea composition (instance-level; call once per
 * keymap+renderer pair):
 *   1. Suspend the focused textarea's own keyBinding processing.
 *   2. Register the edit-buffer command names + handlers.
 *   3. Register a layer with the FILTERED binding set, gated on
 *      `hasManagedTextareaFocus`.
 *
 * Returns a cleanup function that tears down all three in reverse order.
 */
export function registerManagedTextareaComposition(
    keymap: Keymap<Renderable, KeyEvent>,
    renderer: CliRenderer,
): () => void {
    const { keybinds } = resolveKeybindConfig();
    const offCommands = registerEditBufferCommands(keymap, renderer);
    const offSuspension = registerTextareaMappingSuspension(keymap, renderer);
    const offLayer = keymap.registerLayer({
        enabled: () => hasManagedTextareaFocus(renderer),
        bindings: createConfigDrivenTextareaBindings(keybinds),
    });
    // Emacs kill-ring (T5): a higher-priority layer shadowing ctrl+w/k/u to
    // capture killed text, plus the new ctrl+y/alt+y yank/yank-pop chords.
    const offKillRing = registerKillRingLayer(keymap, renderer, {
        hasFocus: () => hasManagedTextareaFocus(renderer),
    });
    return () => {
        offKillRing();
        offLayer();
        offSuspension();
        offCommands();
    };
}

/**
 * Register the custom chat submit command + bindings (return/kpenter) at a
 * higher priority than the filtered bindings layer so Enter submits via
 * `bridgeSubmit` (IME-safe) instead of the addon default `editor.submit()`.
 *
 * The `submitHandler` is `() => bridgeSubmit(core, textareaRef)`, provided by
 * the caller (ChatRoot) so this module stays decoupled from the bridge core.
 *
 * Returns a cleanup function.
 */
export function registerChatSubmitLayer(
    keymap: Keymap<Renderable, KeyEvent>,
    renderer: CliRenderer,
    submitHandler: () => void,
): () => void {
    const offLayer = keymap.registerLayer({
        // Higher priority than the filtered bindings layer (default priority)
        // so return/kpenter resolve to chat.submit, not input.newline.
        priority: 100,
        enabled: () => hasManagedTextareaFocus(renderer),
        commands: [createChatSubmitCommand(submitHandler)],
        bindings: [
            { key: 'return', cmd: CHAT_SUBMIT_COMMAND },
            { key: 'kpenter', cmd: CHAT_SUBMIT_COMMAND },
        ],
    });
    return offLayer;
}
