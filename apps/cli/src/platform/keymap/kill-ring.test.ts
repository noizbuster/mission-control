/**
 * T5 acceptance tests: emacs kill-ring + yank/yank-pop + kill-on-delete.
 *
 * Drives a REAL host-agnostic keymap from `@opentui/keymap/testing` (pure JS,
 * no native FFI) through `host.press(...)`, the faithful equivalent of a
 * renderer keypress. The kill commands (ctrl+w/k/u), yank (ctrl+y), and
 * yank-pop (alt+y) are all single-chord, so no leader addon is needed.
 *
 * A minimal recording editor is defined inline (NOT from
 * `opentui-chat-bridge-test-support.ts`) because that module value-imports
 * `KeyEvent` from `@opentui/core` (native FFI), which is unavailable in the
 * headless test environment. The recording editor implements the same
 * `KillRingEditor` surface the production layer drives on the focused
 * `TextareaRenderable` (reached via `renderer.currentFocusedEditor`).
 *
 * The yank/yank-pop tests inject a pre-populated `KillRing` (dependency
 * injection via the `ring` option) so the yank mechanics are isolated from
 * the kill-capture path; the kill-on-delete tests drive the real ctrl+w/k/u
 * -> ctrl+y flow with the layer's own internal ring.
 *
 * Adversarial coverage (per task spec):
 *  - misleading_success_output: assert the EXACT yanked/inserted text and the
 *    EXACT accumulated ring entry, not just "an insert happened".
 *  - stale_state: yank with an empty ring is a no-op (no insert, no cursor
 *    move); yank-pop with a single entry is a no-op.
 *  - malformed_input: yank-pop when the last action was NOT a yank is a no-op.
 *  - others: N/A (no async / process control / file I/O).
 */

import { createTestKeymap } from '@opentui/keymap/testing';
import { describe, expect, it } from 'vitest';
import { KILL_RING_MAX_ENTRIES, KillRing, type KillRingEditor, registerKillRingLayer } from './kill-ring.js';

// ---------------------------------------------------------------------------
// Inline recording editor (kept FFI-free; mirrors the real editor surface)
// ---------------------------------------------------------------------------

/**
 * Single-line recording editor. Implements the `KillRingEditor` contract the
 * production layer drives on the focused TextareaRenderable. The delete
 * methods model the real editor's cursor movement + text removal so the
 * layer's read-before/delete/read-after diff capture computes the deleted
 * text correctly. `deleteWordBackward` kills `\s*\S+$` (trailing whitespace +
 * word) so three consecutive backward kills reconstruct cleanly.
 */
class RecordingEditor implements KillRingEditor {
    text = '';
    offset = 0;
    selection: { readonly start: number; readonly end: number } | null = null;
    readonly insertTextCalls: string[] = [];

    get plainText(): string {
        return this.text;
    }
    get cursorOffset(): number {
        return this.offset;
    }
    insertText(text: string): void {
        this.insertTextCalls.push(text);
        this.text = this.text.slice(0, this.offset) + text + this.text.slice(this.offset);
        this.offset += text.length;
        this.selection = null;
    }
    setSelection(start: number, end: number): void {
        this.selection = { start, end };
    }
    deleteSelection(): boolean {
        if (this.selection === null) return false;
        const { start, end } = this.selection;
        this.text = this.text.slice(0, start) + this.text.slice(end);
        this.offset = start;
        this.selection = null;
        return true;
    }
    deleteWordBackward(): boolean {
        const before = this.text.slice(0, this.offset);
        const match = before.match(/\s*\S+$/);
        if (match === null) return false;
        const killed = match[0];
        const start = this.offset - killed.length;
        this.text = this.text.slice(0, start) + this.text.slice(this.offset);
        this.offset = start;
        return true;
    }
    deleteToLineEnd(): boolean {
        this.text = this.text.slice(0, this.offset);
        return true;
    }
    deleteToLineStart(): boolean {
        this.text = this.text.slice(this.offset);
        this.offset = 0;
        return true;
    }
}

/** Build a host whose currentFocusedEditor is the recording editor. */
function buildHost(initialText = '') {
    const editor = new RecordingEditor();
    editor.text = initialText;
    editor.offset = initialText.length;
    return { editor, host: { currentFocusedEditor: editor } };
}

// ---------------------------------------------------------------------------
// Pure ring: KillRing
// ---------------------------------------------------------------------------

describe('KillRing (pure)', () => {
    it('peek returns the most recent entry (misleading-success guard)', () => {
        const ring = new KillRing();
        ring.push('a', { prepend: false });
        ring.push('b', { prepend: false });
        expect(ring.peek()).toBe('b');
        expect(ring.length).toBe(2);
    });

    it('peek on an empty ring returns undefined (stale-state guard)', () => {
        const ring = new KillRing();
        expect(ring.peek()).toBeUndefined();
        expect(ring.length).toBe(0);
    });

    it('accumulate=true merges into the most recent entry (append when prepend=false)', () => {
        const ring = new KillRing();
        ring.push('a', { prepend: false });
        ring.push('b', { prepend: false, accumulate: true });
        expect(ring.length).toBe(1);
        expect(ring.peek()).toBe('ab');
    });

    it('accumulate=true with prepend=true prepends to the most recent entry', () => {
        const ring = new KillRing();
        ring.push('B', { prepend: true });
        ring.push('A', { prepend: true, accumulate: true });
        expect(ring.length).toBe(1);
        expect(ring.peek()).toBe('AB');
    });

    it('accumulate=false always creates a new entry', () => {
        const ring = new KillRing();
        ring.push('a', { prepend: false });
        ring.push('b', { prepend: true });
        expect(ring.length).toBe(2);
        expect(ring.peek()).toBe('b');
    });

    it('push of empty text is a no-op', () => {
        const ring = new KillRing();
        ring.push('', { prepend: false });
        expect(ring.length).toBe(0);
    });

    it('rotate moves the last entry to the front (for yank-pop cycling)', () => {
        const ring = new KillRing();
        ring.push('first', { prepend: false });
        ring.push('second', { prepend: false });
        ring.push('third', { prepend: false });
        expect(ring.peek()).toBe('third');
        ring.rotate();
        expect(ring.peek()).toBe('second');
        ring.rotate();
        expect(ring.peek()).toBe('first');
        ring.rotate();
        expect(ring.peek()).toBe('third');
    });

    it('rotate with one or zero entries is a no-op', () => {
        const ring = new KillRing();
        ring.rotate();
        expect(ring.length).toBe(0);
        ring.push('only', { prepend: false });
        ring.rotate();
        expect(ring.peek()).toBe('only');
        expect(ring.length).toBe(1);
    });

    it(`caps at ${KILL_RING_MAX_ENTRIES} entries (oldest dropped)`, () => {
        const ring = new KillRing();
        for (let i = 0; i < KILL_RING_MAX_ENTRIES + 5; i++) {
            ring.push(`e${i}`, { prepend: false });
        }
        expect(ring.length).toBe(KILL_RING_MAX_ENTRIES);
        expect(ring.peek()).toBe(`e${KILL_RING_MAX_ENTRIES + 4}`);
    });
});

// ---------------------------------------------------------------------------
// Layer dispatch: yank / yank-pop (ring injected to isolate mechanics)
// ---------------------------------------------------------------------------

describe('T5 kill-ring layer — yank (acceptance a)', () => {
    it('ctrl+y inserts the most-recent ring entry at the cursor via insertText', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { editor, host } = buildHost('before|after');
        editor.offset = 'before'.length;

        const ring = new KillRing();
        ring.push('killed text', { prepend: false });
        const off = registerKillRingLayer(harness.keymap, host, { ring });

        harness.host.press('y', { ctrl: true });

        expect(editor.insertTextCalls).toEqual(['killed text']);
        expect(editor.plainText).toBe('beforekilled text|after');
        expect(editor.cursorOffset).toBe('beforekilled text'.length);

        off();
        harness.cleanup();
    });

    it('ctrl+y with an EMPTY ring is a no-op (stale-state guard, acceptance d)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { editor, host } = buildHost('hello');
        const off = registerKillRingLayer(harness.keymap, host, { ring: new KillRing() });

        harness.host.press('y', { ctrl: true });

        expect(editor.insertTextCalls).toEqual([]);
        expect(editor.plainText).toBe('hello');
        expect(editor.cursorOffset).toBe('hello'.length);

        off();
        harness.cleanup();
    });
});

describe('T5 kill-ring layer — yank-pop (acceptance b)', () => {
    it('alt+y cycles to the previous entry replacing the just-yanked span', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { editor, host } = buildHost('start');

        const ring = new KillRing();
        ring.push('first', { prepend: false });
        ring.push('second', { prepend: false });
        const off = registerKillRingLayer(harness.keymap, host, { ring });

        harness.host.press('y', { ctrl: true }); // "second"
        expect(editor.plainText).toBe('startsecond');
        harness.host.press('y', { meta: true }); // yank-pop -> "first"

        expect(editor.plainText).toBe('startfirst');
        expect(editor.insertTextCalls).toEqual(['second', 'first']);
        off();
        harness.cleanup();
    });

    it('alt+y again cycles further through the ring', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { editor, host } = buildHost('x');

        const ring = new KillRing();
        ring.push('a', { prepend: false });
        ring.push('b', { prepend: false });
        ring.push('c', { prepend: false });
        const off = registerKillRingLayer(harness.keymap, host, { ring });

        harness.host.press('y', { ctrl: true }); // "c"
        harness.host.press('y', { meta: true }); // -> "b"
        harness.host.press('y', { meta: true }); // -> "a"
        expect(editor.plainText).toBe('xa');
        off();
        harness.cleanup();
    });

    it('alt+y with a single ring entry is a no-op (stale-state guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { editor, host } = buildHost('x');

        const ring = new KillRing();
        ring.push('only', { prepend: false });
        const off = registerKillRingLayer(harness.keymap, host, { ring });

        harness.host.press('y', { ctrl: true }); // "only"
        harness.host.press('y', { meta: true }); // single entry -> no-op

        expect(editor.plainText).toBe('xonly');
        off();
        harness.cleanup();
    });

    it('alt+y when the last action was NOT a yank is a no-op (malformed-input guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { editor, host } = buildHost('x');

        const ring = new KillRing();
        ring.push('a', { prepend: false });
        ring.push('b', { prepend: false });
        const off = registerKillRingLayer(harness.keymap, host, { ring });

        // yank-pop WITHOUT a preceding yank -> no-op
        harness.host.press('y', { meta: true });

        expect(editor.insertTextCalls).toEqual([]);
        expect(editor.plainText).toBe('x');
        off();
        harness.cleanup();
    });
});

// ---------------------------------------------------------------------------
// Layer dispatch: kill-on-delete (drives the real ctrl+w/k/u -> ctrl+y flow)
// ---------------------------------------------------------------------------

describe('T5 kill-ring layer — kill-on-delete (acceptance c)', () => {
    it('three consecutive ctrl+w accumulate into ONE ring entry; ctrl+y yanks all', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { editor, host } = buildHost('alpha beta gamma');
        const off = registerKillRingLayer(harness.keymap, host);

        harness.host.press('w', { ctrl: true }); // kill " gamma"
        harness.host.press('w', { ctrl: true }); // kill " beta"
        harness.host.press('w', { ctrl: true }); // kill "alpha"

        expect(editor.plainText).toBe('');

        harness.host.press('y', { ctrl: true }); // yank the accumulated entry
        expect(editor.insertTextCalls).toEqual(['alpha beta gamma']);
        expect(editor.plainText).toBe('alpha beta gamma');
        off();
        harness.cleanup();
    });

    it('ctrl+k pushes the killed tail (forward delete) and ctrl+y yanks it', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { editor, host } = buildHost('hello world');
        editor.offset = 'hello'.length;
        const off = registerKillRingLayer(harness.keymap, host);

        harness.host.press('k', { ctrl: true }); // kill " world"
        expect(editor.plainText).toBe('hello');

        harness.host.press('y', { ctrl: true });
        expect(editor.plainText).toBe('hello world');
        off();
        harness.cleanup();
    });

    it('ctrl+u pushes the killed head (backward delete) and ctrl+y yanks it', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { editor, host } = buildHost('hello world');
        editor.offset = 'hello'.length;
        const off = registerKillRingLayer(harness.keymap, host);

        harness.host.press('u', { ctrl: true }); // kill "hello"
        expect(editor.plainText).toBe(' world');
        expect(editor.cursorOffset).toBe(0);

        harness.host.press('y', { ctrl: true });
        expect(editor.plainText).toBe('hello world');
        off();
        harness.cleanup();
    });

    it('a kill then a yank then a kill does NOT accumulate across the yank', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const { editor, host } = buildHost('foo bar baz');
        const off = registerKillRingLayer(harness.keymap, host);

        harness.host.press('w', { ctrl: true }); // kill " baz" -> entry 1
        harness.host.press('y', { ctrl: true }); // yank " baz" (resets kill-run)
        harness.host.press('w', { ctrl: true }); // kill " baz" again -> NEW entry

        harness.host.press('y', { ctrl: true }); // yanks the most-recent
        expect(editor.insertTextCalls[editor.insertTextCalls.length - 1]).toBe(' baz');
        off();
        harness.cleanup();
    });

    it('kill/yank when no editor is focused is a no-op (resolve-null guard)', () => {
        // NOTE: the layer's `enabled` gate is honored only by the activation
        // compilers the production opentui keymap registers (verified live in
        // T3); the headless test keymap does not register them, so `enabled`
        // alone cannot gate dispatch here. The testable safety net is the
        // command handler's own resolve() null-guard: with no focused editor
        // the kill captures nothing and the yank inserts nothing.
        const harness = createTestKeymap({ defaultKeys: true });
        harness.host.focus(harness.root);
        const ring = new KillRing();
        const off = registerKillRingLayer(harness.keymap, { currentFocusedEditor: null }, { ring });

        harness.host.press('w', { ctrl: true });
        harness.host.press('y', { ctrl: true });

        expect(ring.length).toBe(0);
        off();
        harness.cleanup();
    });
});
