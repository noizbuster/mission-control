/**
 * Test seam: `#`-workflow menu completion lives across the exported
 * `bridgeContentChange` (mirrors typed text + refreshes menus) and
 * `bridgeTextareaKeyDown` (Up/Down navigation) / `bridgeSubmit` (Enter
 * completion + final submission). `bridgeSubmit` is IME-double-deferred
 * (nested setTimeout), so these tests flush it with fake timers. They assert
 * the textarea was rewritten via `setText` / a `{type:'line'}` event — NOT
 * `core.inputBuffer` as the editing source of truth.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    bridgeContentChange,
    bridgeSubmit,
    bridgeTextareaKeyDown,
    createOpenTuiChatBridgeCore,
} from './opentui-chat-bridge.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
    makeKeyEvent,
    type RecordingTextarea,
} from './opentui-chat-bridge-test-support.js';

function flushSubmit(): void {
    vi.runAllTimers();
}

function setup(workflowNames: readonly string[] = [], typed = '') {
    const core = createOpenTuiChatBridgeCore();
    core.workflowNames = workflowNames;
    const textarea = createRecordingTextarea();
    // The textarea is the source of truth; seed it natively, then mirror.
    textarea.type(typed);
    bridgeContentChange(core, typed);
    const textareaRef = asTextareaRef(textarea);
    const scrollboxRef = asScrollboxRef(createRecordingScrollbox());
    return { core, textarea, textareaRef, scrollboxRef };
}

describe('opentui bridge workflow menu completion', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('completes the selected workflow into the textarea on Enter without submitting', () => {
        const { core, textarea, textareaRef, scrollboxRef } = setup(['default', 'planner', 'runner'], '#');

        bridgeTextareaKeyDown(core, makeKeyEvent('down'), textareaRef, scrollboxRef);
        bridgeTextareaKeyDown(core, makeKeyEvent('return'), textareaRef, scrollboxRef);
        flushSubmit();

        expect(textarea.setTextCalls).toEqual(['#planner ']);
        expect(textarea.gotoBufferEndCount).toBe(1);
        expect(core.eventQueue.shift()).toBeUndefined();
    });

    it('keeps the default (first) workflow when Enter is pressed without arrow navigation', () => {
        const { core, textarea, textareaRef, scrollboxRef } = setup(['planner', 'runner'], '#');

        bridgeTextareaKeyDown(core, makeKeyEvent('return'), textareaRef, scrollboxRef);
        flushSubmit();

        expect(textarea.setTextCalls).toEqual(['#planner ']);
        expect(core.eventQueue.shift()).toBeUndefined();
    });

    it('submits the full line on a second Enter after the user types the prompt', () => {
        const { core, textarea, textareaRef, scrollboxRef } = setup(['planner'], '#');

        bridgeTextareaKeyDown(core, makeKeyEvent('return'), textareaRef, scrollboxRef);
        flushSubmit();
        expect(textarea.setTextCalls).toEqual(['#planner ']);

        // User types the prompt past the completed workflow name.
        textarea.type('#planner ship it');
        bridgeContentChange(core, '#planner ship it');
        bridgeTextareaKeyDown(core, makeKeyEvent('return'), textareaRef, scrollboxRef);
        flushSubmit();

        expect(core.eventQueue.shift()).toEqual({ type: 'line', value: '#planner ship it' });
    });

    it('submits directly when the prompt was already typed past the workflow name', () => {
        const { core, textareaRef, scrollboxRef } = setup(['planner'], '#planner ship it');

        bridgeTextareaKeyDown(core, makeKeyEvent('return'), textareaRef, scrollboxRef);
        flushSubmit();

        expect(core.eventQueue.shift()).toEqual({ type: 'line', value: '#planner ship it' });
    });

    it('lets the user filter with a partial query before completing', () => {
        const { core, textarea, textareaRef, scrollboxRef } = setup(['default', 'planner', 'runner'], '#pl');

        bridgeTextareaKeyDown(core, makeKeyEvent('return'), textareaRef, scrollboxRef);
        flushSubmit();

        expect(textarea.setTextCalls).toEqual(['#planner ']);
        expect(core.eventQueue.shift()).toBeUndefined();
    });

    it('completes the highlighted choice after navigating up', () => {
        const { core, textarea, textareaRef, scrollboxRef } = setup(['default', 'planner', 'runner'], '#');

        bridgeTextareaKeyDown(core, makeKeyEvent('down'), textareaRef, scrollboxRef);
        bridgeTextareaKeyDown(core, makeKeyEvent('down'), textareaRef, scrollboxRef);
        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        bridgeTextareaKeyDown(core, makeKeyEvent('return'), textareaRef, scrollboxRef);
        flushSubmit();

        expect(textarea.setTextCalls).toEqual(['#planner ']);
    });

    it('does not rewrite the textarea when bridgeSubmit is given an empty buffer', () => {
        const textarea: RecordingTextarea = createRecordingTextarea();
        const core = createOpenTuiChatBridgeCore();

        bridgeSubmit(core, asTextareaRef(textarea));
        flushSubmit();

        expect(textarea.calls.filter((c) => c.method === 'setText')).toEqual([]);
        expect(core.eventQueue.shift()).toBeUndefined();
    });
});
