/**
 * Single keymap instance for the mctrl opentui TUI (T1 foundation + T7 leader).
 *
 * This module is the ONE place a `Keymap<Renderable, KeyEvent>` is built for the
 * chat bridge. Later todos (T2/T3/T7/...) register app-specific addons and
 * bindings against the instance returned here; T1 stands up a working base
 * keymap plus the framework-agnostic, bootstrap-safe addon set, and T7 layers
 * the leader / comma / escape-clears / backspace-pops universal addons on top.
 *
 * Lazy-loading: `@opentui/keymap/opentui` transitively imports `@opentui/core`
 * (the native FFI backend) as a runtime value, so this module is imported
 * lazily — only the opentui bridge (TUI path) ever loads it. The `--no-tui`
 * path never touches this module, keeping the native renderer out of its
 * module graph (see apps/cli/AGENTS.md "opentui renderer mount/unmount"). The
 * `import type` lines below are erased at compile time and do not load core.
 */

import type { CliRenderer, KeyEvent, Renderable } from '@opentui/core';
import type { Keymap } from '@opentui/keymap';
import { createDefaultOpenTuiKeymap } from '@opentui/keymap/opentui';
import { type BindingValue, LeaderDefault } from './keybind.js';
import { resolveKeybindConfig } from './keybind-config-loader.js';
import { LEADER_TIMEOUT_MS, registerLeaderAddons } from './leader-addons.js';

/** The concrete opentui keymap type threaded through the React bridge. */
export type OpenTuiKeymap = Keymap<Renderable, KeyEvent>;

/**
 * Composite disposers for the leader-family addons registered per keymap.
 * Keyed weakly so a disposed keymap's entry is collected with it. The keymap
 * outlives only as long as its renderer; the host's destroy path tears down
 * the keymap hooks, and these addon intercepts/listeners are released with
 * it. The map exists so an explicit teardown path (tests, future
 * renderer-recycling) can invoke `disposeKeymapLeaderAddons`.
 */
const leaderAddonDisposers = new WeakMap<OpenTuiKeymap, () => void>();

/**
 * Build the chat keymap for a live renderer.
 *
 * Delegates to `createDefaultOpenTuiKeymap`, which constructs the opentui host
 * adapter (hooks `renderer.keyInput`/focus/destroy events) and registers the
 * framework-agnostic bootstrap addons:
 *   - `registerDefaultKeys` — the `ctrl+shift+s` key parser + event matcher
 *     (required for ANY binding string to parse later).
 *   - `registerEnabledFields` — the `enabled` binding/layer activation field.
 *   - `registerMetadataFields` — `desc`/`group`/`title`/`category` fields used by
 *     command-palette and which-key display (T8/T9).
 *
 * On top of those, T7 registers the leader-family universal addons via
 * `registerLeaderAddons` (timed leader on the resolved leader chord from
 * `keybind.ts`, comma-bindings, escape-clears-pending, backspace-pops-pending).
 *
 * T17 makes the leader trigger config-driven: `resolveKeybindConfig()` loads
 * the user's `keybinds.json` (3-scope first-wins, mirroring skill discovery)
 * and the resolved `leader` chord is what arms the timed-leader addon, so a
 * user override (`{"leader": "ctrl+b"}`) flows into the live keymap. The
 * timeout is `LEADER_TIMEOUT_MS`.
 *
 * T16 extends the config threading to the textarea `input.*` layer:
 * `registerManagedTextareaComposition` also calls `resolveKeybindConfig()` and
 * passes the resolved `Keybinds` into `createConfigDrivenTextareaBindings`, so
 * user overrides flow to the input.* bindings too (not just the leader + /hotkeys
 * display). The loader's mtime-based cache ensures the file is read at most once.
 *
 * DELIBERATELY DEFERRED (their own todos — do NOT register here):
 *   - `registerBaseLayoutFallback` → T2/T7 (app layout bindings).
 *   - `registerManagedTextareaLayer` / `registerEditBufferCommands` /
 *     `registerTextareaMappingSuspension` → T3 (managed textarea layer;
 *     registerManagedTextareaLayer is forbidden per the plan — lower-level
 *     composition is used there instead).
 *   - app command bindings (palette/which-key/model-cycle/agent-cycle) → T8/T9/T11.
 *
 * `createDefaultOpenTuiKeymap` throws if the renderer is already destroyed; the
 * provider only calls this while the renderer is live (it obtained it via
 * `useRenderer()` from a mounted opentui root).
 */
export function createKeymapInstance(renderer: CliRenderer): OpenTuiKeymap {
    const { keybinds } = resolveKeybindConfig();
    const keymap = createDefaultOpenTuiKeymap(renderer);
    const dispose = registerLeaderAddons(keymap, {
        trigger: leaderTriggerFromConfig(keybinds.leader),
        timeoutMs: LEADER_TIMEOUT_MS,
    });
    leaderAddonDisposers.set(keymap, dispose);
    return keymap;
}

/**
 * Resolve the leader trigger from the config-driven value. Only string chords
 * flow through; object/disabled leaders fall back to the default so the leader
 * subsystem always arms (the addon expects a resolvable chord).
 */
function leaderTriggerFromConfig(value: BindingValue): string {
    return typeof value === 'string' ? value : LeaderDefault;
}

/**
 * Tear down the leader / comma / escape-clears / backspace-pops addons
 * registered for `keymap`. No-op when none were registered (the keymap was
 * created elsewhere or already disposed). The keymap instance itself is not
 * destroyed here — only the T7 addon registrations are removed.
 */
export function disposeKeymapLeaderAddons(keymap: OpenTuiKeymap): void {
    const dispose = leaderAddonDisposers.get(keymap);
    if (dispose) {
        dispose();
        leaderAddonDisposers.delete(keymap);
    }
}
