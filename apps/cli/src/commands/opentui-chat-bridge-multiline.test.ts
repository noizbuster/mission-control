/**
 * Test seam: Shift+Enter / Alt+Enter newline insertion is now NATIVE textarea
 * behavior via the `ChatInputTextarea` keyBindings (`{return,shift,newline}`,
 * `{return,submit}`, default `{return,meta,submit}`) — those bindings are
 * covered headlessly in `components/ChatInputTextarea.test.tsx`. What remains
 * testable at the bridge layer is that `bridgeSubmit` submits a multi-line
 * `plainText` value intact (newlines preserved) and clears the textarea. These
 * tests drive `bridgeSubmit` (IME-double-deferred, flushed with fake timers).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bridgeSubmit, createOpenTuiChatBridgeCore } from './opentui-chat-bridge.js';
import {
    asTextareaRef,
    createRecordingTextarea,
} from './chat-test-support.js';

describe('opentui bridge multi-line submit via bridgeSubmit', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('submits a multi-line plainText value intact (newlines preserved) and clears the textarea', () => {
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('line one\nline two');

        bridgeSubmit(core, asTextareaRef(textarea));
        vi.runAllTimers();

        expect(core.eventQueue.shift()).toEqual({ type: 'line', value: 'line one\nline two' });
        expect(textarea.clearCount).toBe(1);
        expect(core.inputBuffer).toBe('');
    });

    it('echoes the multi-line user input to outputText on submit', () => {
        const core = createOpenTuiChatBridgeCore();

        bridgeSubmit(core, asTextareaRef(createRecordingTextarea('line one\nline two')));
        vi.runAllTimers();

        expect(core.outputText).toBe('You: line one\nline two\n');
    });

    it('still submits single-line input intact', () => {
        const core = createOpenTuiChatBridgeCore();

        bridgeSubmit(core, asTextareaRef(createRecordingTextarea('hello')));
        vi.runAllTimers();

        expect(core.eventQueue.shift()).toEqual({ type: 'line', value: 'hello' });
    });

    it('does not submit an empty or whitespace-only plainText', () => {
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('   ');

        bridgeSubmit(core, asTextareaRef(textarea));
        vi.runAllTimers();

        expect(core.eventQueue.shift()).toBeUndefined();
        expect(core.outputText).toBe('');
    });
});
