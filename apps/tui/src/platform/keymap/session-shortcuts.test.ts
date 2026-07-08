/**
 * T12 acceptance tests: session-tree keyboard nav + prompt stash (in-memory
 * LIFO) + queued-prompts view.
 *
 * Drives a REAL host-agnostic keymap from `@opentui/keymap/testing` (pure JS,
 * no native FFI) through `host.press(...)`, which is the faithful equivalent of
 * a renderer keypress. The `<leader>down`/`<leader>q`/`<leader>s`/`<leader>p`/
 * `<leader>i` chords need the leader token, so `registerLeaderAddons` (T7,
 * pure JS addon) + fake timers drive them deterministically. The bare
 * `up`/`right`/`left` session-tree chords need no leader.
 *
 * The session-tree + prompt-stash chords are NOT yet in the keybind.ts
 * registry (T2/T4 only shipped `session_queued_prompts`), so they are defined
 * locally in session-shortcuts.ts. The test pins them at the layer level.
 *
 * Adversarial coverage (per task spec):
 *  - misleading_success_output: (a) stash restores the EXACT buffer+cursor, not
 *    just "a restore happened"; (b) each session-tree key resolves to its
 *    EXACT direction; (c) the queued-prompts notice names the data source.
 *  - stale_state: (d) pop on an empty stash is a no-op (no restore call); (e)
 *    each PromptStash instance is isolated (one session's stash does not leak
 *    into another).
 *  - malformed_input: N/A — no untrusted input crosses a boundary (keys are
 *    keymap-typed, the stash is in-memory typed).
 *  - flaky_tests: the leader timeout is a real `setTimeout`; fake timers make
 *    the leader chords deterministic.
 */

import { createTestKeymap } from '@opentui/keymap/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEADER_TIMEOUT_MS, registerLeaderAddons } from './leader-addons.js';
import type { SessionTreeDirection } from './session-shortcuts.js';
import {
    buildQueuedPromptsNotice,
    MAX_STASH_ENTRIES,
    PromptStash,
    type PromptStashEntry,
    registerSessionShortcutsLayer,
    type SessionShortcutsDeps,
} from './session-shortcuts.js';

// ---------------------------------------------------------------------------
// Inline recording deps (kept FFI-free — no @opentui/core value import)
// ---------------------------------------------------------------------------

interface RecordingDeps extends SessionShortcutsDeps {
    readonly navigated: SessionTreeDirection[];
    readonly captured: PromptStashEntry[];
    readonly clearInputCount: number;
    readonly restored: PromptStashEntry[];
    readonly notices: string[];
}

function createRecordingDeps(captureText = '', captureCursor = 0): RecordingDeps {
    const navigated: SessionTreeDirection[] = [];
    const captured: PromptStashEntry[] = [];
    const restored: PromptStashEntry[] = [];
    const notices: string[] = [];
    let clearedCount = 0;
    let captureIndex = 0;
    const seeds: PromptStashEntry[] = [{ text: captureText, cursor: captureCursor }];
    return {
        navigated,
        captured,
        restored,
        notices,
        get clearInputCount(): number {
            return clearedCount;
        },
        navigateSessionTree(direction: SessionTreeDirection): void {
            navigated.push(direction);
        },
        captureInput(): PromptStashEntry {
            const entry = seeds[captureIndex] ?? seeds[seeds.length - 1] ?? { text: '', cursor: 0 };
            captureIndex += 1;
            captured.push(entry);
            return entry;
        },
        clearInput(): void {
            clearedCount += 1;
        },
        restoreInput(entry: PromptStashEntry): void {
            restored.push(entry);
        },
        emitNotice(text: string): void {
            notices.push(text);
        },
    };
}

/** Press a `<leader><key>` chord against an armed leader (fake-timer safe). */
function pressLeader(harness: ReturnType<typeof createTestKeymap>, followKey: string): void {
    harness.host.press('x', { ctrl: true });
    harness.host.press(followKey);
}

// ---------------------------------------------------------------------------
// Pure unit: PromptStash (LIFO in-memory store)
// ---------------------------------------------------------------------------

describe('PromptStash (in-memory LIFO)', () => {
    it('(a) push then pop restores the EXACT buffer+cursor, LIFO order (misleading-success guard)', () => {
        const stash = new PromptStash();
        stash.push({ text: 'hello world', cursor: 5 });
        stash.push({ text: 'second draft', cursor: 7 });

        // LIFO: most-recent push pops first.
        const first = stash.pop();
        const second = stash.pop();

        expect(first).toEqual({ text: 'second draft', cursor: 7 });
        expect(second).toEqual({ text: 'hello world', cursor: 5 });
        expect(stash.size).toBe(0);
    });

    it('(d) pop on an empty stash returns undefined — a documented no-op (stale-state guard)', () => {
        const stash = new PromptStash();
        expect(stash.pop()).toBeUndefined();
        expect(stash.size).toBe(0);
    });

    it('(e) each PromptStash instance is isolated — one session does not leak into another (stale-state guard)', () => {
        const sessionA = new PromptStash();
        const sessionB = new PromptStash();
        sessionA.push({ text: 'a-draft', cursor: 0 });

        expect(sessionB.size).toBe(0);
        expect(sessionB.pop()).toBeUndefined();
        expect(sessionA.pop()).toEqual({ text: 'a-draft', cursor: 0 });
    });

    it(`caps at MAX_STASH_ENTRIES (${MAX_STASH_ENTRIES}) — oldest dropped on overflow`, () => {
        const stash = new PromptStash();
        for (let index = 0; index < MAX_STASH_ENTRIES + 5; index += 1) {
            stash.push({ text: `draft-${index}`, cursor: index });
        }
        expect(stash.size).toBe(MAX_STASH_ENTRIES);
        // The most-recent push survived (LIFO top).
        expect(stash.pop()).toEqual({ text: `draft-${MAX_STASH_ENTRIES + 4}`, cursor: MAX_STASH_ENTRIES + 4 });
    });
});

// ---------------------------------------------------------------------------
// Pure unit: buildQueuedPromptsNotice (empty-state data source)
// ---------------------------------------------------------------------------

describe('buildQueuedPromptsNotice (queued-prompts view)', () => {
    it('documents the data source as unavailable in interactive mode (acceptance c empty-state)', () => {
        const notice = buildQueuedPromptsNotice({ pendingSteers: 0, pendingQueued: 0, observable: false });
        // The notice MUST name the limitation honestly — not pretend a count.
        expect(notice.toLowerCase()).toContain('unavailable');
    });

    it('lists counts when a real reader IS wired (forward-compatible)', () => {
        const notice = buildQueuedPromptsNotice({ pendingSteers: 2, pendingQueued: 1, observable: true });
        expect(notice).toContain('2');
        expect(notice).toContain('1');
    });
});

// ---------------------------------------------------------------------------
// Layer dispatch: session-tree nav + stash + queue view
// ---------------------------------------------------------------------------

describe('T12 session-shortcuts layer — dispatch', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('session.tree.parent (up) -> navigateSessionTree("parent")', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const deps = createRecordingDeps();
        const off = registerSessionShortcutsLayer(harness.keymap, deps);

        harness.host.press('up');

        expect(deps.navigated).toEqual(['parent']);
        off();
        harness.cleanup();
    });

    it('session.tree.child_next (right) -> navigateSessionTree("next-child")', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const deps = createRecordingDeps();
        const off = registerSessionShortcutsLayer(harness.keymap, deps);

        harness.host.press('right');

        expect(deps.navigated).toEqual(['next-child']);
        off();
        harness.cleanup();
    });

    it('session.tree.child_previous (left) -> navigateSessionTree("prev-child")', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const deps = createRecordingDeps();
        const off = registerSessionShortcutsLayer(harness.keymap, deps);

        harness.host.press('left');

        expect(deps.navigated).toEqual(['prev-child']);
        off();
        harness.cleanup();
    });

    it('session.tree.child_first (<leader>down) -> navigateSessionTree("first-child")', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, {
            trigger: 'ctrl+x',
            timeoutMs: LEADER_TIMEOUT_MS,
        });
        const deps = createRecordingDeps();
        const off = registerSessionShortcutsLayer(harness.keymap, deps);

        pressLeader(harness, 'down');

        expect(deps.navigated).toEqual(['first-child']);
        off();
        offLeader();
        harness.cleanup();
    });

    it('session.queued_prompts (<leader>q) -> emits the empty-state notice (acceptance c)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, {
            trigger: 'ctrl+x',
            timeoutMs: LEADER_TIMEOUT_MS,
        });
        const deps = createRecordingDeps();
        const off = registerSessionShortcutsLayer(harness.keymap, deps);

        pressLeader(harness, 'q');

        // The view opened: exactly one notice, naming the unavailable data source.
        expect(deps.notices).toHaveLength(1);
        expect(deps.notices[0]?.toLowerCase()).toContain('unavailable');
        off();
        offLeader();
        harness.cleanup();
    });

    it('prompt.stash (<leader>s) -> captures input, clears buffer, pushes onto stash', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, {
            trigger: 'ctrl+x',
            timeoutMs: LEADER_TIMEOUT_MS,
        });
        const stash = new PromptStash();
        const deps = createRecordingDeps('stash me', 4);
        const off = registerSessionShortcutsLayer(harness.keymap, deps, { stash });

        pressLeader(harness, 's');

        // captureInput ran and returned the exact entry, then clearInput ran.
        expect(deps.captured).toEqual([{ text: 'stash me', cursor: 4 }]);
        expect(deps.clearInputCount).toBe(1);
        // The entry landed on the shared stash (LIFO top).
        expect(stash.size).toBe(1);
        expect(stash.pop()).toEqual({ text: 'stash me', cursor: 4 });
        off();
        offLeader();
        harness.cleanup();
    });

    it('prompt.stash.pop (<leader>p) -> restores the EXACT stashed buffer+cursor (misleading-success guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, {
            trigger: 'ctrl+x',
            timeoutMs: LEADER_TIMEOUT_MS,
        });
        const stash = new PromptStash();
        stash.push({ text: 'pre-stashed draft', cursor: 9 });
        const deps = createRecordingDeps();
        const off = registerSessionShortcutsLayer(harness.keymap, deps, { stash });

        pressLeader(harness, 'p');

        // EXACT restore — text AND cursor — not just "a restore happened".
        expect(deps.restored).toEqual([{ text: 'pre-stashed draft', cursor: 9 }]);
        expect(stash.size).toBe(0);
        // pop must NOT clear the (already-stashed) buffer or capture new input.
        expect(deps.clearInputCount).toBe(0);
        expect(deps.captured).toEqual([]);
        off();
        offLeader();
        harness.cleanup();
    });

    it('prompt.stash.pop on an EMPTY stash -> no-op, no restore (stale-state guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, {
            trigger: 'ctrl+x',
            timeoutMs: LEADER_TIMEOUT_MS,
        });
        const stash = new PromptStash();
        const deps = createRecordingDeps();
        const off = registerSessionShortcutsLayer(harness.keymap, deps, { stash });

        pressLeader(harness, 'p');

        expect(deps.restored).toEqual([]);
        // The empty-pop surfaces a documented notice (no silent swallow).
        expect(deps.notices).toHaveLength(1);
        off();
        offLeader();
        harness.cleanup();
    });

    it('prompt.stash.list (<leader>i) -> emits a notice with the current count', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, {
            trigger: 'ctrl+x',
            timeoutMs: LEADER_TIMEOUT_MS,
        });
        const stash = new PromptStash();
        stash.push({ text: 'one', cursor: 0 });
        stash.push({ text: 'two', cursor: 0 });
        const deps = createRecordingDeps();
        const off = registerSessionShortcutsLayer(harness.keymap, deps, { stash });

        pressLeader(harness, 'i');

        expect(deps.notices).toHaveLength(1);
        expect(deps.notices[0]).toContain('2');
        off();
        offLeader();
        harness.cleanup();
    });

    it('tearing down the layer stops dispatch (disposer contract)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const deps = createRecordingDeps();
        const off = registerSessionShortcutsLayer(harness.keymap, deps);

        off();

        harness.host.press('up');
        expect(deps.navigated).toEqual([]);
        harness.cleanup();
    });
});
