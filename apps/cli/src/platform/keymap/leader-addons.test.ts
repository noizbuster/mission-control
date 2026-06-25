/**
 * T7 acceptance tests: leader key + comma bindings + escape/backspace pending
 * addons, plus the pending-sequence lifecycle (timeout / escape-clear).
 *
 * Drives a REAL host-agnostic keymap from `@opentui/keymap/testing` (pure JS,
 * no native FFI backend) through `host.press(...)`, which is the faithful
 * equivalent of a renderer keypress — the keymap subscribes to the host's
 * `onKeyPress` and dispatches intercepts + bindings exactly as in production.
 * The four addons under test are the UNIVERSAL ones
 * (`@opentui/keymap/addons`), so `registerLeaderAddons` is exercised against
 * the same addon code path the opentui renderer uses.
 *
 * Adversarial coverage (per task spec):
 *  - misleading_success_output: (a) asserts the `<leader>m` handler ACTUALLY
 *    fires, not just that a pending sequence armed.
 *  - stale_state: (b) the leader pending sequence MUST clear after the
 *    timeout; the next key is NOT treated as a leader continuation.
 *  - cancel_resume: (c) Escape mid-leader clears the sequence without firing
 *    a command.
 *  - flaky_tests: the timeout is timing-sensitive, so fake timers
 *    (`vi.useFakeTimers`) drive it deterministically.
 *  - (d) is the CRITICAL regression guard: `registerEscapeClearsPendingSequence`
 *    must NOT consume Escape when there is no pending sequence, or the existing
 *    4-way bridge Esc ladder (interrupt / close-autocomplete / clear-buffer /
 *    double-Esc) breaks. Verified here by asserting an Escape-bound command
 *    still dispatches with no pending sequence in flight.
 */

import { createTestKeymap } from '@opentui/keymap/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEADER_TIMEOUT_MS, registerLeaderAddons } from './leader-addons.js';

/**
 * Register a `<leader>m` -> command binding + handler that tracks firing.
 * Returns the layer disposer. The command name is unique per call so multiple
 * layers never collide.
 */
function registerLeaderCommand(
    keymap: {
        registerLayer: (layer: {
            readonly commands: readonly { readonly name: string; readonly run: () => boolean }[];
            readonly bindings: readonly { readonly key: string; readonly cmd: string }[];
        }) => () => void;
    },
    marker: { fired: boolean },
    commandName: string,
): () => void {
    return keymap.registerLayer({
        commands: [{ name: commandName, run: () => (marker.fired = true) }],
        bindings: [{ key: '<leader>m', cmd: commandName }],
    });
}

describe('T7 leader + pending-sequence addons', () => {
    beforeEach(() => {
        // The timed-leader addon schedules a real `setTimeout(timeoutMs)` on
        // arm; fake timers make the timeout-clear deterministic and prevent
        // any real-timer flake leaking across tests.
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('(a) <leader>m: ctrl+x then m within the timeout fires the command (misleading-success guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        const off = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });

        const marker = { fired: false };
        const offLayer = registerLeaderCommand(harness.keymap, marker, 't7.model.list');

        // Arm the leader.
        harness.host.press('x', { ctrl: true });
        expect(harness.keymap.hasPendingSequence()).toBe(true);

        // Complete the chord BEFORE the timeout elapses.
        harness.host.press('m');

        // The misleading-success probe: assert the handler ACTUALLY ran, not
        // merely that a pending sequence existed.
        expect(marker.fired).toBe(true);
        expect(harness.keymap.hasPendingSequence()).toBe(false);

        offLayer();
        off();
        harness.cleanup();
    });

    it('(b) after the leader timeout the pending sequence clears and the next key is not a leader-sub (stale-state guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        const off = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });

        const marker = { fired: false };
        const offLayer = registerLeaderCommand(harness.keymap, marker, 't7.model.list.timeout');

        harness.host.press('x', { ctrl: true });
        expect(harness.keymap.hasPendingSequence()).toBe(true);

        // Advance PAST the timeout. The timed-leader addon's setTimeout fires
        // `keymap.clearPendingSequence()`.
        vi.advanceTimersByTime(LEADER_TIMEOUT_MS + 100);
        expect(harness.keymap.hasPendingSequence()).toBe(false);

        // 'm' now arrives with no pending sequence, so it must NOT fire the
        // leader command (it is not treated as a leader continuation).
        harness.host.press('m');
        expect(marker.fired).toBe(false);

        offLayer();
        off();
        harness.cleanup();
    });

    it('(c) ctrl+x then escape clears the pending sequence without firing a command (cancel_resume guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        const off = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });

        const marker = { fired: false };
        const offLayer = registerLeaderCommand(harness.keymap, marker, 't7.model.list.escape');

        harness.host.press('x', { ctrl: true });
        expect(harness.keymap.hasPendingSequence()).toBe(true);

        // Escape cancels the in-progress sequence. The escape-clears addon
        // consumes the Escape (preventDefault default true), so the leader
        // command never fires.
        harness.host.press('escape');

        expect(harness.keymap.hasPendingSequence()).toBe(false);
        expect(marker.fired).toBe(false);

        offLayer();
        off();
        harness.cleanup();
    });

    it('(d) with NO pending sequence, escape is NOT consumed by escape-clears (Esc-ladder regression guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        const off = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });

        // A command bound to bare Escape, standing in for the bridge Esc
        // ladder (the real ladder lives on the textarea onKeyDown, separate
        // from the keymap; this proves escape-clears lets Escape reach
        // dispatch when nothing is pending).
        const marker = { fired: false };
        const offLayer = harness.keymap.registerLayer({
            commands: [{ name: 't7.escape.cmd', run: () => (marker.fired = true) }],
            bindings: [{ key: 'escape', cmd: 't7.escape.cmd' }],
        });

        // No pending sequence in flight.
        expect(harness.keymap.hasPendingSequence()).toBe(false);

        harness.host.press('escape');

        // Escape reached dispatch and fired the command — escape-clears was a
        // no-op. This is the guarantee the existing bridge Esc ladder relies
        // on (T16 later reconciles the full ladder into a keymap handler).
        expect(marker.fired).toBe(true);

        offLayer();
        off();
        harness.cleanup();
    });
});
