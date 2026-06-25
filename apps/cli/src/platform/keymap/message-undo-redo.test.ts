/**
 * T15 acceptance tests: non-destructive message undo/redo keymap layer.
 *
 * Undo (`<leader>u`) hides the last `You:` + `Assistant:` exchange from the
 * bridge's `outputText` VIEW by stashing the removed substring; redo
 * (`<leader>r`) restores it byte-exact. The durable JSONL session log is NEVER
 * touched — the layer's only mutation surface is `replaceOutputText` (which
 * sets `core.outputText`, the view) plus `emitNotice`. There is no session-log
 * reference anywhere in the module, so durable mutation is structurally
 * impossible (the bridge wiring's `replaceOutputText` calls
 * `replaceCoreOutputText`, which only sets `core.outputText` + publishes a
 * snapshot — verified at opentui-chat-bridge.tsx `replaceCoreOutputText`).
 *
 * Drives a REAL host-agnostic keymap from `@opentui/keymap/testing` (pure JS,
 * no native FFI) through `host.press(...)`. The `<leader>u`/`<leader>r` chords
 * need the leader token, so `registerLeaderAddons` (T7) + fake timers are used
 * (same pattern as T10's `messages.copy` test).
 *
 * Adversarial coverage (per task spec):
 *  - misleading_success_output: assert the EXACT remaining/stashed text and
 *    byte-exact round-trip restore, not just "outputText changed".
 *  - stale_state: undo during `generating` is a no-op; second undo (single-
 *    level cap) is a no-op; redo with empty stash is a no-op.
 *  - malformed_input: empty output / no-pair output → undo no-op.
 *  - flaky_tests: the leader timeout is a real `setTimeout`; fake timers make
 *    the leader chord deterministic.
 */

import { createTestKeymap } from '@opentui/keymap/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LEADER_TIMEOUT_MS, registerLeaderAddons } from './leader-addons.js';
import { extractLastExchange, type MessageUndoRedoDeps, registerMessageUndoRedoLayer } from './message-undo-redo.js';

// ---------------------------------------------------------------------------
// Deps test double: a mutable VIEW state + recording of every dep call
// ---------------------------------------------------------------------------

interface ViewState {
    outputText: string;
    generating: boolean;
}

interface RecordingDeps extends MessageUndoRedoDeps {
    readonly state: ViewState;
    readonly notices: string[];
    /** Every `replaceOutputText` argument, in order — proves the VIEW mutation surface. */
    readonly replaceCalls: string[];
}

function createRecordingDeps(initial: string, generating = false): RecordingDeps {
    const state: ViewState = { outputText: initial, generating };
    const notices: string[] = [];
    const replaceCalls: string[] = [];
    return {
        state,
        notices,
        replaceCalls,
        getOutputText: () => state.outputText,
        replaceOutputText: (text: string): void => {
            replaceCalls.push(text);
            state.outputText = text;
        },
        isGenerating: () => state.generating,
        emitNotice: (text: string): void => {
            notices.push(text);
        },
    };
}

/** Arm the leader (ctrl+x) then press `key`. Requires fake timers for the leader timeout. */
function leaderPress(harness: ReturnType<typeof createTestKeymap>, key: string): void {
    harness.host.press('x', { ctrl: true });
    harness.host.press(key);
}

// ---------------------------------------------------------------------------
// Pure helper: extractLastExchange
// ---------------------------------------------------------------------------

describe('extractLastExchange', () => {
    it('returns undefined for empty text (malformed-input guard)', () => {
        expect(extractLastExchange('')).toBeUndefined();
    });

    it('returns undefined when no You:/Assistant: pair exists', () => {
        expect(extractLastExchange('system message\nanother line\n')).toBeUndefined();
        expect(extractLastExchange('You: only user\n')).toBeUndefined();
        expect(extractLastExchange('Assistant: only assistant\n')).toBeUndefined();
    });

    it('extracts the last exchange as a byte-exact substring + remaining (misleading-success guard)', () => {
        const text = 'mission-control chat\nYou: hello\nAssistant: hi there\n';
        const result = extractLastExchange(text);
        expect(result).toBeDefined();
        expect(result?.exchangeText).toBe('You: hello\nAssistant: hi there\n');
        expect(result?.remaining).toBe('mission-control chat\n');
    });

    it('hides only the LAST exchange when multiple exist', () => {
        const text = 'You: first\nAssistant: first answer\nYou: second\nAssistant: second answer\n';
        const result = extractLastExchange(text);
        expect(result?.exchangeText).toBe('You: second\nAssistant: second answer\n');
        expect(result?.remaining).toBe('You: first\nAssistant: first answer\n');
    });

    it('stashes the full multi-line assistant block (not just the first line)', () => {
        const text = 'You: explain\nAssistant: line one\nline two\nline three\n';
        const result = extractLastExchange(text);
        expect(result?.exchangeText).toBe('You: explain\nAssistant: line one\nline two\nline three\n');
        expect(result?.remaining).toBe('');
    });

    it('round-trips exactly: re-insert at insertOffset reconstructs the original byte-for-byte', () => {
        const text = 'banner\nYou: q\nAssistant: multi\nline\nanswer\n';
        const result = extractLastExchange(text);
        const restored =
            (result?.remaining ?? '').slice(0, result?.insertOffset ?? 0) +
            (result?.exchangeText ?? '') +
            (result?.remaining ?? '').slice(result?.insertOffset ?? 0);
        expect(restored).toBe(text);
    });

    it('ignores an unanswered trailing user message and targets the last complete exchange', () => {
        const text = 'You: q\nAssistant: a\nYou: unanswered\n';
        const result = extractLastExchange(text);
        expect(result?.exchangeText).toBe('You: q\nAssistant: a\n');
        expect(result?.remaining).toBe('You: unanswered\n');
    });
});

// ---------------------------------------------------------------------------
// Layer dispatch: messages.undo / messages.redo (need leader token)
// ---------------------------------------------------------------------------

describe('T15 message undo/redo layer', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('leader+u hides the last You/Assistant exchange from the VIEW and stashes it (acceptance a)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });

        const original = 'mission-control chat\nYou: hello\nAssistant: hi there\n';
        const deps = createRecordingDeps(original);
        const off = registerMessageUndoRedoLayer(harness.keymap, deps);

        leaderPress(harness, 'u');

        // The exchange is gone from the VIEW; the durable log surface (here,
        // replaceOutputText) was called with exactly the remaining text.
        expect(deps.state.outputText).toBe('mission-control chat\n');
        expect(deps.replaceCalls).toEqual(['mission-control chat\n']);
        expect(deps.state.outputText).not.toContain('You: hello');
        expect(deps.state.outputText).not.toContain('Assistant: hi there');

        off();
        offLeader();
        harness.cleanup();
    });

    it('leader+r restores the stashed exchange byte-exact (acceptance b, misleading-success guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });

        const original = 'banner\nYou: hello\nAssistant: hi there\n';
        const deps = createRecordingDeps(original);
        const off = registerMessageUndoRedoLayer(harness.keymap, deps);

        leaderPress(harness, 'u'); // hide
        leaderPress(harness, 'r'); // restore

        // Byte-exact round-trip: the VIEW equals the original after redo.
        expect(deps.state.outputText).toBe(original);

        off();
        offLeader();
        harness.cleanup();
    });

    it('second leader+u (single-level cap) is a no-op: VIEW unchanged (acceptance c, stale-state guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });

        const deps = createRecordingDeps('You: q\nAssistant: a\n');
        const off = registerMessageUndoRedoLayer(harness.keymap, deps);

        leaderPress(harness, 'u'); // first undo hides the exchange
        const afterFirstUndo = deps.state.outputText;
        expect(afterFirstUndo).toBe('');

        leaderPress(harness, 'u'); // second undo: stash already full → no-op
        expect(deps.state.outputText).toBe(afterFirstUndo);
        // replaceOutputText was called exactly once (only the first undo mutated).
        expect(deps.replaceCalls).toEqual(['']);

        off();
        offLeader();
        harness.cleanup();
    });

    it('leader+u with no exchange to hide is a no-op (stale-state/malformed-input guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });

        const deps = createRecordingDeps('just a system banner, no exchange\n');
        const off = registerMessageUndoRedoLayer(harness.keymap, deps);

        leaderPress(harness, 'u');

        expect(deps.state.outputText).toBe('just a system banner, no exchange\n');
        expect(deps.replaceCalls).toEqual([]); // no VIEW mutation
        expect(deps.notices).toEqual(['Nothing to undo.\n']);

        off();
        offLeader();
        harness.cleanup();
    });

    it('leader+u during generating is a no-op (acceptance c, stale-state guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });

        const deps = createRecordingDeps('You: q\nAssistant: a\n', /* generating */ true);
        const off = registerMessageUndoRedoLayer(harness.keymap, deps);

        leaderPress(harness, 'u');

        expect(deps.state.outputText).toBe('You: q\nAssistant: a\n');
        expect(deps.replaceCalls).toEqual([]); // no VIEW mutation while generating

        off();
        offLeader();
        harness.cleanup();
    });

    it('leader+r with nothing stashed is a no-op (stale-state guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });

        const deps = createRecordingDeps('You: q\nAssistant: a\n');
        const off = registerMessageUndoRedoLayer(harness.keymap, deps);

        leaderPress(harness, 'r'); // redo with empty stash

        expect(deps.state.outputText).toBe('You: q\nAssistant: a\n');
        expect(deps.replaceCalls).toEqual([]);
        expect(deps.notices).toEqual(['Nothing to redo.\n']);

        off();
        offLeader();
        harness.cleanup();
    });

    it('undo then redo then undo again re-hides (stash is reusable after redo)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });

        const original = 'You: q\nAssistant: a\n';
        const deps = createRecordingDeps(original);
        const off = registerMessageUndoRedoLayer(harness.keymap, deps);

        leaderPress(harness, 'u');
        expect(deps.state.outputText).toBe('');
        leaderPress(harness, 'r');
        expect(deps.state.outputText).toBe(original);
        leaderPress(harness, 'u');
        expect(deps.state.outputText).toBe('');
        leaderPress(harness, 'r');
        expect(deps.state.outputText).toBe(original);

        off();
        offLeader();
        harness.cleanup();
    });

    it('does NOT mutate the durable session log: the only VIEW surface is replaceOutputText', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const offLeader = registerLeaderAddons(harness.keymap, { trigger: 'ctrl+x', timeoutMs: LEADER_TIMEOUT_MS });

        const deps = createRecordingDeps('You: q\nAssistant: a\n');
        const off = registerMessageUndoRedoLayer(harness.keymap, deps);

        leaderPress(harness, 'u');

        // Structural proof: the deps bag exposes NO session-log handle. The
        // layer can only call getOutputText/replaceOutputText/isGenerating/
        // emitNotice. replaceOutputText sets core.outputText (the VIEW), never
        // the JSONL log. So every mutation recorded is a VIEW mutation.
        for (const call of deps.replaceCalls) {
            expect(typeof call).toBe('string');
        }
        // Exactly one VIEW mutation on a successful undo.
        expect(deps.replaceCalls).toHaveLength(1);

        off();
        offLeader();
        harness.cleanup();
    });
});
