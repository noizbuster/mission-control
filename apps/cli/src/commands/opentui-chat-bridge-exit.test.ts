import type { InkKeyShape } from './opentui-chat-bridge.js';
import { describe, expect, it } from 'vitest';
import { createOpenTuiChatBridgeCore, handleInput, type OpenTuiChatBridgeCore } from './opentui-chat-bridge.js';

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

describe('ink chat bridge Ctrl+C with partial input clears buffer', () => {
    it('enqueues interrupt with interruptedPartialInput=true and clears the buffer when Ctrl+C is pressed with text', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'hello', makeKey());
        expect(core.inputBuffer).toBe('hello');

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toEqual({
            type: 'interrupt',
            interruptedPartialInput: true,
            source: 'ctrl-c',
        });
        expect(core.inputBuffer).toBe('');
        expect(core.cursorPosition).toBe(0);
    });

    it('allows a second Ctrl+C on the now-empty buffer to enqueue an exit interrupt', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'hello', makeKey());
        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toEqual({
            type: 'interrupt',
            interruptedPartialInput: true,
            source: 'ctrl-c',
        });

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toEqual({
            type: 'interrupt',
            interruptedPartialInput: false,
            source: 'ctrl-c',
        });
        expect(core.inputBuffer).toBe('');
    });
});

describe('ink chat bridge Ctrl+D exit and forward-delete', () => {
    it('enqueues an interrupt event when the buffer is empty and Ctrl+D is pressed', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'd', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toEqual({
            type: 'interrupt',
            interruptedPartialInput: false,
            source: 'ctrl-c',
        });
    });

    it('does not append d to the input buffer when Ctrl+D is pressed on an empty buffer', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'd', makeKey({ ctrl: true }));

        expect(core.inputBuffer).toBe('');
        expect(core.cursorPosition).toBe(0);
    });

    it('is a no-op when the buffer is non-empty and the cursor is at the end', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'hello', makeKey());
        expect(core.inputBuffer).toBe('hello');
        expect(core.cursorPosition).toBe(5);

        handleInput(core, 'd', makeKey({ ctrl: true }));

        expect(core.inputBuffer).toBe('hello');
        expect(core.cursorPosition).toBe(5);
        expect(nextEvent(core)).toBeUndefined();
    });

    it('forward-deletes the character at the cursor (cursor mid-buffer)', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'hello', makeKey());
        core.cursorPosition = 2;

        handleInput(core, 'd', makeKey({ ctrl: true }));

        expect(core.inputBuffer).toBe('helo');
        expect(core.cursorPosition).toBe(2);
        expect(nextEvent(core)).toBeUndefined();
    });

    it('forward-deletes the first character when the cursor is at position 0', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'hello', makeKey());
        core.cursorPosition = 0;

        handleInput(core, 'd', makeKey({ ctrl: true }));

        expect(core.inputBuffer).toBe('ello');
        expect(core.cursorPosition).toBe(0);
        expect(nextEvent(core)).toBeUndefined();
    });

    it('still appends d to the input buffer when ctrl is not held (regression)', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'd', makeKey());

        expect(core.inputBuffer).toBe('d');
        expect(core.cursorPosition).toBe(1);
        expect(nextEvent(core)).toBeUndefined();
    });
});
