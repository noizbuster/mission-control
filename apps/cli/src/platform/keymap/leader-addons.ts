/**
 * Leader / comma / escape / backspace addon registration for the mctrl keymap
 * (T7).
 *
 * This is the host-agnostic half of T7: it imports ONLY from
 * `@opentui/keymap/addons` (the universal addons) and `@opentui/keymap` types,
 * never `@opentui/core`. That keeps it unit-testable against
 * `createTestKeymap` (`@opentui/keymap/testing`, pure JS, no native FFI) and
 * lets `keymap-instance.ts` pull it in without widening the FFI boundary
 * beyond what `createDefaultOpenTuiKeymap` already requires.
 *
 * Registers four universal addons onto a keymap and returns ONE composite
 * disposer that tears them all down (mirrors opencode's
 * `registerOpencodeKeymap` disposer pattern at `tui/src/keymap.tsx:214-244`):
 *
 *   - `registerTimedLeader({trigger, name, timeoutMs})` — arms the `<leader>`
 *     token on the trigger key (default `ctrl+x` from `keybind.ts`) and
 *     clears the pending sequence if no follow-up key arrives before
 *     `timeoutMs`. The timeout is a real `setTimeout`
 *     (`addons/universal/timed-leader`), so fake timers drive it
 *     deterministically in tests.
 *   - `registerCommaBindings()` — expands comma-separated binding strings
 *     (`j,k` -> two bindings).
 *   - `registerEscapeClearsPendingSequence()` — Escape cancels an in-progress
 *     multi-key sequence. CRITICAL: the addon consumes Escape ONLY when a
 *     pending sequence exists (`addons/universal/escape-clears-pending-sequence`
 *     early-returns on `!hasPendingSequence()`, verified at
 *     `addons/index.js:629-631`). When nothing is pending, Escape passes
 *     through untouched, so the existing 4-way bridge Esc ladder
 *     (interrupt / close-autocomplete / clear-buffer / double-Esc) keeps
 *     working. T16 later reconciles the full ladder into a keymap handler.
 *   - `registerBackspacePopsPendingSequence()` — Backspace steps back through
 *     the current pending sequence.
 *
 * The leader trigger is NOT hardcoded here: `keymap-instance.ts` sources it
 * from `keybind.ts` (`LeaderDefault = 'ctrl+x'`) so a future rebindable
 * config (T17) flows through.
 */

import type { Keymap, KeymapEvent } from '@opentui/keymap';
import {
    registerBackspacePopsPendingSequence,
    registerCommaBindings,
    registerEscapeClearsPendingSequence,
    registerTimedLeader,
} from '@opentui/keymap/addons';

/** The leader token name. `<leader>` in binding strings resolves to this. */
export const LEADER_TOKEN_NAME = 'leader';

/**
 * Leader pending-sequence timeout.
 *
 * opencode reads this from a config value (`leader_timeout`); mctrl has no such
 * config yet, so a sane default ships here. 1000ms is long enough to
 * comfortably press a two-key combo (median inter-key interval for chord
 * sequences is ~150-300ms) yet short enough that a stray leader press clears
 * before the user resumes typing. The underlying addon default is 1500ms.
 */
export const LEADER_TIMEOUT_MS = 1000;

export interface LeaderAddonOptions {
    /** The trigger chord that arms the leader (e.g. `'ctrl+x'`). */
    readonly trigger: string;
    /** Ms before an armed-but-uncompleted leader sequence auto-clears. */
    readonly timeoutMs: number;
}

/**
 * Register the leader / comma / escape-clears / backspace-pops universal
 * addons onto `keymap`. Returns a composite disposer that tears all four down
 * in reverse-registration order (mirrors opencode's teardown sequence).
 *
 * Generic over the keymap's target/event types so a real
 * `Keymap<Renderable, KeyEvent>` and a test
 * `Keymap<TestKeymapTarget, TestKeymapEvent>` both satisfy it without casts.
 */
export function registerLeaderAddons<TTarget extends object, TEvent extends KeymapEvent>(
    keymap: Keymap<TTarget, TEvent>,
    options: LeaderAddonOptions,
): () => void {
    const offLeader = registerTimedLeader(keymap, {
        trigger: options.trigger,
        name: LEADER_TOKEN_NAME,
        timeoutMs: options.timeoutMs,
    });
    const offComma = registerCommaBindings(keymap);
    // Default options: preventDefault true, priority 0. Escape is consumed
    // ONLY when a pending sequence exists (verified addon contract), which is
    // the desired cancel-mid-leader behavior and leaves the bridge Esc ladder
    // intact when nothing is pending.
    const offEscape = registerEscapeClearsPendingSequence(keymap);
    const offBackspace = registerBackspacePopsPendingSequence(keymap);

    let disposed = false;
    return () => {
        if (disposed) return;
        disposed = true;
        offBackspace();
        offEscape();
        offComma();
        offLeader();
    };
}
