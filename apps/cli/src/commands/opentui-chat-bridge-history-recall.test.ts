/**
 * Test seam: prompt history recall lives in the exported `bridgeTextareaKeyDown`
 * Up/Down branch. The contract (post todo 4): Up recalls when the textarea
 * cursor is at offset 0 (top of buffer) OR once history navigation has started
 * (`isNavigatingChatInputHistory`); Down recalls at the buffer end. Recall
 * rewrites the textarea via `setText` + `gotoBufferEnd` and mirrors into the
 * core. These tests drive Up/Down with a recording `TextareaLike` whose
 * `cursorOffset` is seeded to the relevant bound and assert `core.history` /
 * `core.inputBuffer` (mirror) / the textarea's recorded `setText` calls.
 */
import { describe, expect, it } from 'vitest';
import { bridgeContentChange, bridgeTextareaKeyDown, createOpenTuiChatBridgeCore } from './opentui-chat-bridge.js';
import { createChatInputHistoryFromEntries } from './interactive-chat-input-history.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
    makeKeyEvent,
} from './opentui-chat-bridge-test-support.js';

function recallSetup(initial = '', cursorOffset?: number) {
    const core = createOpenTuiChatBridgeCore();
    const textarea = createRecordingTextarea(initial, cursorOffset);
    const textareaRef = asTextareaRef(textarea);
    const scrollboxRef = asScrollboxRef(createRecordingScrollbox());
    // Mirror the seeded buffer so core.inputBuffer reflects the textarea.
    bridgeContentChange(core, initial);
    return { core, textarea, textareaRef, scrollboxRef };
}

describe('opentui bridge prompt history recall via bridgeTextareaKeyDown', () => {
    it('walks back one entry per Up press through plain prompts (cursor at top)', () => {
        const { core, textareaRef, scrollboxRef } = recallSetup('', 0);
        core.history = createChatInputHistoryFromEntries(['oldest', 'middle', 'newest']);

        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('newest');
        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('middle');
        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('oldest');
        // Bounded at the oldest entry — a further Up is a no-op.
        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('oldest');
    });

    it('continues walking history after recalling a `/`-prefixed entry', () => {
        // Regression guard: once navigating, history owns the arrows even when
        // the recalled buffer starts with `/` (slash menu does not recapture).
        const { core, textareaRef, scrollboxRef } = recallSetup('', 0);
        core.history = createChatInputHistoryFromEntries(['plain older', '/model claude']);

        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('/model claude');
        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('plain older');
    });

    it('continues walking history after recalling a `#`-prefixed entry', () => {
        const { core, textareaRef, scrollboxRef } = recallSetup('', 0);
        core.history = createChatInputHistoryFromEntries(['plain older', '#planner {ship it}']);

        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('#planner {ship it}');
        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('plain older');
    });

    it('walks forward on Down and clears to the draft at the bottom', () => {
        const { core, textareaRef, scrollboxRef } = recallSetup('', 0);
        core.history = createChatInputHistoryFromEntries(['old', 'recent']);

        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('recent');
        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('old');
        // Down walks forward; after recall the cursor sits at the buffer end,
        // so Down is at-bound and recalls.
        bridgeTextareaKeyDown(core, makeKeyEvent('down'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('recent');
        bridgeTextareaKeyDown(core, makeKeyEvent('down'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('');
    });

    it('still routes Up to the slash-command menu when typing `/` at the draft slot', () => {
        // Guard against an over-broad change: at the draft slot (not navigating),
        // with cursor NOT at the top, the prefix menu keeps winning.
        const { core, textarea, textareaRef, scrollboxRef } = recallSetup('/', 1);
        core.history = createChatInputHistoryFromEntries(['never recalled']);

        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);

        expect(core.history.cursor).toBe(core.history.entries.length);
        expect(core.inputBuffer).toBe('/');
        expect(textarea.setTextCalls).toEqual([]);
    });

    it('does not recall on Up when the cursor is mid-buffer and not navigating (native cursor move wins)', () => {
        const { core, textarea, textareaRef, scrollboxRef } = recallSetup('hello', 2);
        core.history = createChatInputHistoryFromEntries(['old']);

        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);

        expect(core.inputBuffer).toBe('hello');
        expect(textarea.setTextCalls).toEqual([]);
    });

    it('restores a captured draft when navigating back down to the bottom', () => {
        // Realistic new flow: a draft is captured when the first Up fires from
        // the top of the buffer (cursor offset 0). Seed the textarea with a
        // draft whose cursor has been moved Home (offset 0).
        const { core, textarea, textareaRef, scrollboxRef } = recallSetup('half-typed draft', 0);
        core.history = createChatInputHistoryFromEntries(['old', 'recent']);

        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('recent');
        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('old');
        bridgeTextareaKeyDown(core, makeKeyEvent('down'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('recent');
        // Back to the draft slot restores the captured draft.
        bridgeTextareaKeyDown(core, makeKeyEvent('down'), textareaRef, scrollboxRef);
        expect(core.inputBuffer).toBe('half-typed draft');
        // The recall rewrites the textarea via setText for each navigation step.
        expect(textarea.setTextCalls).toContain('half-typed draft');
    });

    it('exposes the current navigation position through the snapshot', () => {
        const { core, textareaRef, scrollboxRef } = recallSetup('', 0);
        core.history = createChatInputHistoryFromEntries(['a', 'b']);

        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.snapshot.historyNavigation).toEqual({ position: 2, total: 2 });
        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.snapshot.historyNavigation).toEqual({ position: 1, total: 2 });
        bridgeTextareaKeyDown(core, makeKeyEvent('down'), textareaRef, scrollboxRef);
        bridgeTextareaKeyDown(core, makeKeyEvent('down'), textareaRef, scrollboxRef);
        expect(core.snapshot.historyNavigation).toBeNull();
    });

    it('calls preventDefault on Up/Down when recalling history', () => {
        const { core, textareaRef, scrollboxRef } = recallSetup('', 0);
        core.history = createChatInputHistoryFromEntries(['old']);
        const up = makeKeyEvent('up');

        bridgeTextareaKeyDown(core, up, textareaRef, scrollboxRef);

        expect(up.defaultPrevented).toBe(true);
    });
});
