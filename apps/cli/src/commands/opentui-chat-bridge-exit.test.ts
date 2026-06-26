/**
 * Test seam: Ctrl+C still flows through the exported `handleInput` global sink
 * (exit-critical, routed there unconditionally); Ctrl+D moved to the exported
 * `bridgeTextareaKeyDown` (forward-delete via textarea `deleteChar`, or an
 * interrupt when the buffer is empty). Typing is mirrored via
 * `bridgeContentChange`. Buffer clearing on Ctrl+C is the textarea's
 * responsibility (Esc path), so these tests assert the enqueued interrupt +
 * `interruptedPartialInput` flag and the textarea's recorded `deleteChar`.
 */
import { describe, expect, it } from 'vitest';
import {
    bridgeContentChange,
    bridgeTextareaKeyDown,
    createOpenTuiChatBridgeCore,
    handleInput,
    type OpenTuiChatBridgeCore,
} from './opentui-chat-bridge.js';
import type { InkKeyShape } from './opentui-chat-bridge.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
    makeKeyEvent,
} from './chat-test-support.js';

function makeKey(overrides: Partial<InkKeyShape> = {}): InkKeyShape {
    return {
        upArrow: false,
        downArrow: false,
        leftArrow: false,
        rightArrow: false,
        pageDown: false,
        pageUp: false,
        home: false,
        end: false,
        return: false,
        escape: false,
        ctrl: false,
        shift: false,
        tab: false,
        backspace: false,
        delete: false,
        meta: false,
        super: false,
        hyper: false,
        capsLock: false,
        numLock: false,
        ...overrides,
    };
}

function nextEvent(core: OpenTuiChatBridgeCore): unknown {
    return core.eventQueue.shift();
}

describe('opentui bridge Ctrl+C interrupt via handleInput', () => {
    it('enqueues an interrupt with interruptedPartialInput=true when the buffer has text', () => {
        const core = createOpenTuiChatBridgeCore();
        bridgeContentChange(core, 'hello');

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toEqual({
            type: 'interrupt',
            interruptedPartialInput: true,
            source: 'ctrl-c',
        });
    });

    it('enqueues an interrupt with interruptedPartialInput=false when the buffer is empty', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toEqual({
            type: 'interrupt',
            interruptedPartialInput: false,
            source: 'ctrl-c',
        });
    });

    it('allows a second Ctrl+C on the now-empty buffer to enqueue another exit interrupt', () => {
        const core = createOpenTuiChatBridgeCore();
        bridgeContentChange(core, 'hello');

        handleInput(core, 'c', makeKey({ ctrl: true }));
        expect(nextEvent(core)).toEqual({
            type: 'interrupt',
            interruptedPartialInput: true,
            source: 'ctrl-c',
        });

        // Buffer is still mirrored as 'hello' (Ctrl+C does not clear it; the
        // textarea/Esc path owns clearing). The exit-counting in the main loop
        // keys off interruptedPartialInput, so a real second press arrives with
        // an empty buffer once the textarea has cleared.
        bridgeContentChange(core, '');
        handleInput(core, 'c', makeKey({ ctrl: true }));
        expect(nextEvent(core)).toEqual({
            type: 'interrupt',
            interruptedPartialInput: false,
            source: 'ctrl-c',
        });
    });
});

describe('opentui bridge Ctrl+D exit and forward-delete via bridgeTextareaKeyDown', () => {
    it('enqueues an interrupt event when the buffer is empty and Ctrl+D is pressed', () => {
        const core = createOpenTuiChatBridgeCore();

        bridgeTextareaKeyDown(
            core,
            makeKeyEvent('d', { ctrl: true }),
            asTextareaRef(createRecordingTextarea()),
            asScrollboxRef(createRecordingScrollbox()),
        );

        expect(nextEvent(core)).toEqual({
            type: 'interrupt',
            interruptedPartialInput: false,
            source: 'ctrl-c',
        });
    });

    it('is a no-op (no delete, no event) when the buffer is non-empty and the cursor is at the end', () => {
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('hello');

        bridgeTextareaKeyDown(
            core,
            makeKeyEvent('d', { ctrl: true }),
            asTextareaRef(textarea),
            asScrollboxRef(createRecordingScrollbox()),
        );

        expect(textarea.deleteCharCount).toBe(1);
        expect(textarea.plainText).toBe('hello');
        expect(nextEvent(core)).toBeUndefined();
    });

    it('forward-deletes the character at the cursor via textarea deleteChar (cursor mid-buffer)', () => {
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('hello', 2);

        bridgeTextareaKeyDown(
            core,
            makeKeyEvent('d', { ctrl: true }),
            asTextareaRef(textarea),
            asScrollboxRef(createRecordingScrollbox()),
        );

        expect(textarea.deleteCharCount).toBe(1);
        expect(textarea.plainText).toBe('helo');
        expect(nextEvent(core)).toBeUndefined();
    });

    it('forward-deletes the first character when the cursor is at offset 0', () => {
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('hello', 0);

        bridgeTextareaKeyDown(
            core,
            makeKeyEvent('d', { ctrl: true }),
            asTextareaRef(textarea),
            asScrollboxRef(createRecordingScrollbox()),
        );

        expect(textarea.plainText).toBe('ello');
        expect(nextEvent(core)).toBeUndefined();
    });

    it('calls preventDefault on the Ctrl+D KeyEvent', () => {
        const core = createOpenTuiChatBridgeCore();
        const key = makeKeyEvent('d', { ctrl: true });

        bridgeTextareaKeyDown(
            core,
            key,
            asTextareaRef(createRecordingTextarea()),
            asScrollboxRef(createRecordingScrollbox()),
        );

        expect(key.defaultPrevented).toBe(true);
    });
});
