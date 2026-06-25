/**
 * Model favorites store + F2 recent-model-cycle + leader+1..9 quick-switch
 * keymap layer (T11).
 *
 * Three concerns, one FFI-free module:
 *
 *  1. `ModelFrecency` — a recency-ordered list of recently-used models with a
 *     cursor for forward/backward cycling. Mirrors an IDE "recent files" list.
 *  2. `ModelFavorites` — a fixed 9-slot in-memory favorites store (slot 1..9).
 *  3. `registerModelShortcutsLayer` — a SESSION-scoped keymap layer wiring
 *     F2 / Shift+F2 (recent cycle) and `<leader>1..9` (quick switch) to the
 *     same model-selection mechanism `handleModelCycle` uses
 *     (`OpenTuiChatBridge.onModelCycleSelect`).
 *
 * Design decisions (see also learnings.md):
 *
 *  - **F2 walks WITHOUT reordering.** Each F2/Shift+F2 press advances the
 *    cursor through the recency-ordered list and does NOT call `record`. This
 *    is deliberate: recording on every step would keep the two most-recent
 *    models at the front and reduce the cycle to a 2-item toggle (the IDE
 *    Ctrl+Tab behavior), which is the wrong UX for "cycle through all recent
 *    models". Reordering happens only on an explicit `record` (a favorites
 *    jump, or a future Ctrl+P / `/model` hook).
 *  - **`Ctrl+P` / `Shift+Ctrl+P` are untouched.** T11 ADDS F2 + favorites
 *    alongside the documented model cycle; it does NOT reassign or replace it.
 *  - **SESSION-scoped, not textarea-gated.** Model switching fires regardless
 *    of input focus (like the T10 messages layer), so `enabled: () => true`.
 *    The F2 / `<leader>N` chords do not collide with any textarea or messages
 *    chord, so there is no layer-priority conflict.
 *  - **Lazy seed.** The frecency starts empty. On the first F2 press it seeds
 *    itself from the available model list (`deps.getModelSelections`) so the
 *    cycle works from the very first press; favorites jumps and future
 *    selection hooks then refine the order.
 *
 * Module-graph safety: imports only `@opentui/keymap` types (erased at compile
 * time), the `ModelProviderSelection` protocol type, and the pure-data
 * `keybind.ts` registry. NO `@opentui/core`. Dynamically imported by the opentui
 * bridge (TUI path only) so `--no-tui` stays clean.
 *
 * allow: SIZE_OK — T11's deliverable mandates a single `model-favorites.ts`
 * holding the frecency store + favorites store + their keymap layer. The two
 * stores exist solely to back this one layer, so the file owns a single noun
 * phrase ("model favorites + recent-cycle shortcuts"). Splitting would fragment
 * a mandated deliverable; cohesion is high.
 */

import type { ModelProviderSelection } from '@mission-control/protocol';
import type { Command, Keymap, KeymapEvent } from '@opentui/keymap';
import { CommandMap, expandToChords, type InputBinding, type KeybindName, Keybinds } from './keybind.js';

// ---------------------------------------------------------------------------
// ModelProviderSelection helpers (pure)
// ---------------------------------------------------------------------------

/**
 * Stable identity key for a `ModelProviderSelection`. Two selections with the
 * same provider/model/variant are the same model. Used for frecency dedupe and
 * equality.
 */
export function selectionKey(selection: ModelProviderSelection): string {
    const variant = selection.variantID;
    return variant === undefined
        ? `${selection.providerID}/${selection.modelID}`
        : `${selection.providerID}/${selection.modelID}#${variant}`;
}

/** Structural equality for two selections. */
export function selectionsEqual(left: ModelProviderSelection, right: ModelProviderSelection): boolean {
    return selectionKey(left) === selectionKey(right);
}

/**
 * Reorder `choices` so `current` is first (if present), preserving the relative
 * order of the rest. Used by the lazy seed so the frecency's front reflects the
 * active model. Returns `choices` unchanged when `current` is absent or not in
 * the list.
 */
export function seedOrdering(
    choices: readonly ModelProviderSelection[],
    current: ModelProviderSelection | undefined,
): readonly ModelProviderSelection[] {
    if (current === undefined) return choices;
    let found = false;
    const rest: ModelProviderSelection[] = [];
    for (const choice of choices) {
        if (!found && selectionsEqual(choice, current)) {
            found = true;
            continue;
        }
        rest.push(choice);
    }
    return found ? [current, ...rest] : choices;
}

// ---------------------------------------------------------------------------
// ModelFrecency
// ---------------------------------------------------------------------------

/** Cap on remembered models. Bounded so the cycle stays navigable. */
const FRECENCY_MAX_ENTRIES = 16;

/**
 * Recency-ordered list of recently-used models plus a cursor for forward/
 * backward cycling. Front = most recent. The cursor points at the "current"
 * cycle position; `next`/`prev` move it WITHOUT reordering the list.
 *
 * `record` is the ONLY method that reorders (dedupe + prepend + cursor reset).
 * Walking never records — see the module header for why.
 */
export class ModelFrecency {
    private readonly entries: ModelProviderSelection[] = [];
    private cursor = 0;

    /** Dedupe by identity, prepend the selection, reset the cursor to front. */
    record(selection: ModelProviderSelection): void {
        const key = selectionKey(selection);
        for (let i = 0; i < this.entries.length; i++) {
            if (selectionKey(this.entries[i] ?? selection) === key) {
                this.entries.splice(i, 1);
                break;
            }
        }
        this.entries.unshift(selection);
        if (this.entries.length > FRECENCY_MAX_ENTRIES) {
            this.entries.length = FRECENCY_MAX_ENTRIES;
        }
        this.cursor = 0;
    }

    /**
     * Bulk-initialize from a list (first entry = front / "current"). Used by the
     * layer's lazy seed on the first F2 press when nothing has been recorded.
     * No dedupe semantics beyond identity; identical-by-key later entries win
     * their earlier position (kept simple — seed sources are already unique).
     */
    seedFrom(selections: readonly ModelProviderSelection[]): void {
        if (this.entries.length > 0) return;
        for (const selection of selections) {
            this.entries.push(selection);
            if (this.entries.length >= FRECENCY_MAX_ENTRIES) break;
        }
        this.cursor = 0;
    }

    /**
     * Advance the cursor forward and return the entry. Returns `undefined` when
     * the list has 0 or 1 entries (nothing to cycle to). Does NOT record.
     */
    next(): ModelProviderSelection | undefined {
        if (this.entries.length <= 1) return undefined;
        this.cursor = (this.cursor + 1) % this.entries.length;
        return this.entries[this.cursor];
    }

    /**
     * Advance the cursor backward and return the entry. Returns `undefined` when
     * the list has 0 or 1 entries. Does NOT record.
     */
    prev(): ModelProviderSelection | undefined {
        if (this.entries.length <= 1) return undefined;
        this.cursor = (this.cursor - 1 + this.entries.length) % this.entries.length;
        return this.entries[this.cursor];
    }

    /** A snapshot of the recency-ordered entries (front = most recent). */
    ordered(): readonly ModelProviderSelection[] {
        return [...this.entries];
    }

    /** Number of recorded entries. */
    get size(): number {
        return this.entries.length;
    }
}

// ---------------------------------------------------------------------------
// ModelFavorites
// ---------------------------------------------------------------------------

/** Number of quick-switch slots (`<leader>1` .. `<leader>9`). */
export const MODEL_FAVORITES_SLOT_COUNT = 9;

/**
 * Fixed 9-slot in-memory favorites store. Slots are 1-indexed (1..9) to match
 * the `<leader>1..9` chords and the `model_quick_switch_1..9` keybind names.
 * In-memory only for T11; persistence is an optional future enhancement.
 */
export class ModelFavorites {
    private readonly slots: (ModelProviderSelection | undefined)[] = new Array(MODEL_FAVORITES_SLOT_COUNT).fill(
        undefined,
    );

    /** Set the model for slot `slot` (1..9). Overwrites any prior value. */
    set(slot: number, selection: ModelProviderSelection): void {
        const index = this.slotIndex(slot);
        this.slots[index] = selection;
    }

    /** Get the model for slot `slot` (1..9), or `undefined` when empty. */
    get(slot: number): ModelProviderSelection | undefined {
        return this.slots[this.slotIndex(slot)];
    }

    /** Clear slot `slot` (1..9). */
    clear(slot: number): void {
        this.slots[this.slotIndex(slot)] = undefined;
    }

    /** Snapshot of all 9 slots (index 0 = slot 1). */
    list(): readonly (ModelProviderSelection | undefined)[] {
        return [...this.slots];
    }

    private slotIndex(slot: number): number {
        if (slot < 1 || slot > MODEL_FAVORITES_SLOT_COUNT || !Number.isInteger(slot)) {
            throw new Error(`Invalid favorite slot: ${slot} (expected 1..${MODEL_FAVORITES_SLOT_COUNT})`);
        }
        return slot - 1;
    }
}

// ---------------------------------------------------------------------------
// Layer dependencies (injected by the bridge)
// ---------------------------------------------------------------------------

/**
 * Dependencies the model-shortcuts layer needs from the bridge. Kept decoupled
 * from bridge internals (same pattern as T10 `MessagesScrollDeps`) so the module
 * stays FFI-free and unit-testable against `createTestKeymap`.
 *
 * `selectModel` is a PURE selection (it calls the bridge's
 * `onModelCycleSelect`); it does NOT touch the frecency. The layer records into
 * the frecency explicitly where a commit is intended (favorites jump).
 */
export interface ModelShortcutsDeps {
    /** The recency store powering F2 / Shift+F2. */
    readonly frecency: ModelFrecency;
    /** The favorites store powering `<leader>1..9`. */
    readonly favorites: ModelFavorites;
    /** Available model selections, used to lazily seed an empty frecency. */
    getModelSelections(): readonly ModelProviderSelection[];
    /** The currently active model selection, or `undefined` when unknown. */
    getCurrentSelection(): ModelProviderSelection | undefined;
    /** Apply a model selection (the same path `handleModelCycle` uses). */
    selectModel(selection: ModelProviderSelection): void;
    /** Surface a user-visible notice (empty-slot no-op, empty frecency). */
    emitNotice(text: string): void;
}

// ---------------------------------------------------------------------------
// Config-driven bindings (sourced from the keybind.ts registry)
// ---------------------------------------------------------------------------

/** The 11 model-shortcut commands T11 owns (recent cycle + 9 quick switches). */
const MODEL_SHORTCUT_BINDINGS = [
    'model_cycle_recent',
    'model_cycle_recent_reverse',
    'model_quick_switch_1',
    'model_quick_switch_2',
    'model_quick_switch_3',
    'model_quick_switch_4',
    'model_quick_switch_5',
    'model_quick_switch_6',
    'model_quick_switch_7',
    'model_quick_switch_8',
    'model_quick_switch_9',
] as const satisfies readonly KeybindName[];

/**
 * Build the chord -> command bindings for the 11 model-shortcut commands from
 * the keybind.ts registry (config-driven, rebindable via T17 overrides).
 * `model_cycle_recent` -> `'f2'`, `model_cycle_recent_reverse` -> `'shift+f2'`,
 * `model_quick_switch_N` -> `'<leader>N'`.
 */
export function modelShortcutsBindings(
    keybinds: ReturnType<typeof Keybinds.parse> = Keybinds.parse({}),
): readonly InputBinding[] {
    const result: InputBinding[] = [];
    for (const name of MODEL_SHORTCUT_BINDINGS) {
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

/** Notice written when F2/Shift+F2 has nothing to cycle to. */
const NO_RECENT_MODELS_NOTICE = 'No recently-used models to cycle to yet';

/**
 * Register the F2 recent-cycle + leader+1..9 quick-switch layer onto `keymap`.
 * Generic over the keymap's target/event types so a real
 * `Keymap<Renderable, KeyEvent>` and a test `Keymap<TestKeymapTarget,
 * TestKeymapEvent>` both satisfy it without casts (same pattern as T10/T7).
 *
 * Returns the layer disposer. The layer is SESSION-scoped (`enabled: () => true`
 * within the ChatRoot mount = session active) and NOT textarea-gated, so the
 * model-shortcut chords fire whether or not the chat input is focused.
 */
export function registerModelShortcutsLayer<TTarget extends object, TEvent extends KeymapEvent>(
    keymap: Keymap<TTarget, TEvent>,
    deps: ModelShortcutsDeps,
): () => void {
    const cycleRecent = (direction: 1 | -1): boolean => {
        // Lazy seed: first F2 press populates the frecency from the model list
        // so the cycle works immediately, before any explicit `record`. The
        // currently-active model is seeded at the front (most recent) so the
        // first F2 lands on the next-most-recent rather than the active model.
        if (deps.frecency.size === 0) {
            deps.frecency.seedFrom(seedOrdering(deps.getModelSelections(), deps.getCurrentSelection()));
        }
        const target = direction === 1 ? deps.frecency.next() : deps.frecency.prev();
        if (target === undefined) {
            deps.emitNotice(NO_RECENT_MODELS_NOTICE);
            return false;
        }
        // Walk only — do NOT record (see module header). The selection flows
        // through the same mechanism as Ctrl+P (bridge.onModelCycleSelect).
        deps.selectModel(target);
        return true;
    };

    const quickSwitch = (slot: number): boolean => {
        const favorite = deps.favorites.get(slot);
        if (favorite === undefined) {
            deps.emitNotice(`Model slot ${slot} is empty (set one with /model favorite ${slot})`);
            return false;
        }
        // A favorites jump is a clear commit: record it so the frecency reflects
        // the jump, then select via the shared path.
        deps.frecency.record(favorite);
        deps.selectModel(favorite);
        return true;
    };

    const commands: Command<TTarget, TEvent>[] = [
        {
            name: 'model.cycle_recent',
            desc: 'Next recently used model',
            run: () => cycleRecent(1),
        },
        {
            name: 'model.cycle_recent.reverse',
            desc: 'Previous recently used model',
            run: () => cycleRecent(-1),
        },
    ];
    // The 9 quick-switch commands are identical modulo the slot number. Generated
    // in a loop (with `let` per-iteration binding so each closure captures its
    // own slot) instead of 9 copy-pasted literals.
    for (let slot = 1; slot <= MODEL_FAVORITES_SLOT_COUNT; slot++) {
        commands.push({
            name: `model.quick_switch.${slot}`,
            desc: `Switch to favorited model slot ${slot}`,
            run: () => quickSwitch(slot),
        });
    }

    return keymap.registerLayer({
        enabled: () => true,
        commands,
        bindings: modelShortcutsBindings(),
    });
}
