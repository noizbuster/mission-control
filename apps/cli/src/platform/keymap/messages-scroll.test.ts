/**
 * T10 acceptance tests: messages scroll (line / half-page / first / last) +
 * copy-last-assistant-message keymap layer.
 *
 * Drives a REAL host-agnostic keymap from `@opentui/keymap/testing` (pure JS,
 * no native FFI) through `host.press(...)`, which is the faithful equivalent of
 * a renderer keypress. The `<leader>y` chord (messages.copy) requires the leader
 * token, so `registerLeaderAddons` (T7, pure JS addon) is called in the copy
 * test. The scroll chords (ctrl+alt+y/e/u/d, ctrl+shift+home/end) need no
 * leader.
 *
 * A minimal recording scrollbox + fake clipboard are defined inline (NOT from
 * `opentui-chat-bridge-test-support.ts`) because that module value-imports
 * `KeyEvent` from `@opentui/core` (native FFI), which is unavailable in the
 * headless test environment.
 *
 * Adversarial coverage (per task spec):
 *  - misleading_success_output: assert EXACT scroll deltas (±1, ±half) and the
 *    EXACT last-assistant text passed to copyToClipboard, not just "a call
 *    happened".
 *  - stale_state: messages.first (ctrl+shift+home) must NOT fire the ABG overlay
 *    toggle (ctrl+g) — verified by an abg.overlay.toggle command spy staying
 *    uncalled after pressing ctrl+shift+home.
 *  - malformed_input: messages.copy with no assistant text is a no-op (no
 *    clipboard mutation).
 *  - flaky_tests: the leader timeout is a real `setTimeout`; fake timers make
 *    the leader chord deterministic.
 */

import { createTestKeymap } from '@opentui/keymap/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ClipboardService } from '../clipboard-service.js';
import { LEADER_TIMEOUT_MS, registerLeaderAddons } from './leader-addons.js';
import { halfPageScrollDelta, registerMessagesScrollLayer, type ScrollboxLike } from './messages-scroll.js';

// ---------------------------------------------------------------------------
// Inline test doubles (kept FFI-free)
// ---------------------------------------------------------------------------

interface RecordingScrollbox extends ScrollboxLike {
    readonly scrollToCalls: number[];
    readonly scrollByCalls: number[];
}

function createRecordingScrollbox(scrollHeight: number): RecordingScrollbox {
    const scrollToCalls: number[] = [];
    const scrollByCalls: number[] = [];
    return {
        scrollToCalls,
        scrollByCalls,
        scrollHeight,
        scrollTo(target: number): void {
            scrollToCalls.push(target);
        },
        scrollBy(delta: number): void {
            scrollByCalls.push(delta);
        },
    };
}

interface FakeClipboard extends ClipboardService {
    readonly copied: string[];
}

function createFakeClipboard(): FakeClipboard {
    const copied: string[] = [];
    return {
        copied,
        copyToClipboard(text: string): Promise<boolean> {
            copied.push(text);
            return Promise.resolve(true);
        },
        isOsc52Supported(): boolean {
            return true;
        },
    };
}

/** Build a deps bag around a recording scrollbox + fake clipboard + text provider. */
function buildDeps(scrollHeight: number, lastAssistantText: string) {
    const scrollbox = createRecordingScrollbox(scrollHeight);
    const clipboard = createFakeClipboard();
    return {
        scrollbox,
        clipboard,
        deps: {
            scrollboxRef: { current: scrollbox as ScrollboxLike | null },
            clipboardService: clipboard,
            getLastAssistantText: () => lastAssistantText,
        },
    };
}

// ---------------------------------------------------------------------------
// Pure helper: halfPageScrollDelta
// ---------------------------------------------------------------------------

describe('halfPageScrollDelta', () => {
    it('floors rows/2 — 24 rows = 12, 25 rows = 12, 1 row = 0 (misleading-success guard)', () => {
        expect(halfPageScrollDelta(24)).toBe(12);
        expect(halfPageScrollDelta(25)).toBe(12);
        expect(halfPageScrollDelta(1)).toBe(0);
        expect(halfPageScrollDelta(0)).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// Layer dispatch: scroll commands
// ---------------------------------------------------------------------------

describe('T10 messages scroll layer — scroll dispatch', () => {
    // Not tautological: the pure halfPageScrollDelta test independently pins
    // floor(rows/2), so a handler bug (scrolling by `rows`) fails this.
    const expectedHalf = halfPageScrollDelta(process.stdout.rows ?? 24);

    it('messages.line.up (ctrl+alt+y) scrollBy(-1)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { scrollbox, deps } = buildDeps(100, '');
        const off = registerMessagesScrollLayer(harness.keymap, deps);

        harness.host.press('y', { ctrl: true, meta: true });

        expect(scrollbox.scrollByCalls).toEqual([-1]);
        expect(scrollbox.scrollToCalls).toEqual([]);

        off();
        harness.cleanup();
    });

    it('messages.line.down (ctrl+alt+e) scrollBy(+1)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { scrollbox, deps } = buildDeps(100, '');
        const off = registerMessagesScrollLayer(harness.keymap, deps);

        harness.host.press('e', { ctrl: true, meta: true });

        expect(scrollbox.scrollByCalls).toEqual([1]);

        off();
        harness.cleanup();
    });

    it('messages.half_page.up (ctrl+alt+u) scrollBy(-12) for 24 rows (acceptance a)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { scrollbox, deps } = buildDeps(200, '');
        const off = registerMessagesScrollLayer(harness.keymap, deps);

        harness.host.press('u', { ctrl: true, meta: true });

        // The EXACT expected delta, not just "a scroll happened".
        expect(scrollbox.scrollByCalls).toEqual([-expectedHalf]);

        off();
        harness.cleanup();
    });

    it('messages.half_page.down (ctrl+alt+d) scrollBy(+12) for 24 rows', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { scrollbox, deps } = buildDeps(200, '');
        const off = registerMessagesScrollLayer(harness.keymap, deps);

        harness.host.press('d', { ctrl: true, meta: true });

        expect(scrollbox.scrollByCalls).toEqual([expectedHalf]);

        off();
        harness.cleanup();
    });

    it('messages.first (ctrl+shift+home) scrollTo(0) and does NOT toggle abg overlay (acceptance c, stale-state guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { scrollbox, deps } = buildDeps(200, '');

        // Register an abg.overlay.toggle command spy — it must NOT fire when
        // ctrl+shift+home is pressed (no chord collision with ctrl+g).
        let abgFired = false;
        harness.keymap.registerLayer({
            commands: [{ name: 'abg.overlay.toggle', run: () => (abgFired = true) }],
            bindings: [{ key: 'ctrl+g', cmd: 'abg.overlay.toggle' }],
        });

        const off = registerMessagesScrollLayer(harness.keymap, deps);

        harness.host.press('home', { ctrl: true, shift: true });

        expect(scrollbox.scrollToCalls).toEqual([0]);
        expect(abgFired).toBe(false);

        off();
        harness.cleanup();
    });

    it('messages.last (ctrl+shift+end) scrollTo(scrollHeight)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { scrollbox, deps } = buildDeps(350, '');
        const off = registerMessagesScrollLayer(harness.keymap, deps);

        // ctrl+shift+end is one of the two alternatives expanded from
        // 'ctrl+shift+end,end' (comma = alternatives via registerCommaBindings).
        harness.host.press('end', { ctrl: true, shift: true });

        expect(scrollbox.scrollToCalls).toEqual([350]);

        off();
        harness.cleanup();
    });
});

// ---------------------------------------------------------------------------
// Layer dispatch: copy command (needs leader token)
// ---------------------------------------------------------------------------

describe('T10 messages.copy (leader+y)', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('leader+y copies the EXACT last-assistant text (acceptance b, misleading-success guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });

        const expectedText = '2 + 2 = 4';
        const { clipboard, deps } = buildDeps(100, expectedText);
        const off = registerMessagesScrollLayer(harness.keymap, deps);

        // Arm leader (ctrl+x), then press y within the timeout.
        harness.host.press('x', { ctrl: true });
        expect(harness.keymap.hasPendingSequence()).toBe(true);

        harness.host.press('y');

        // The EXACT text, not just "a copy happened".
        expect(clipboard.copied).toEqual([expectedText]);

        off();
        offLeader();
        harness.cleanup();
    });

    it('leader+y with NO assistant text is a no-op — no clipboard mutation (malformed-input guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });

        const { clipboard, deps } = buildDeps(100, '');
        const off = registerMessagesScrollLayer(harness.keymap, deps);

        harness.host.press('x', { ctrl: true });
        harness.host.press('y');

        expect(clipboard.copied).toEqual([]);

        off();
        offLeader();
        harness.cleanup();
    });
});
