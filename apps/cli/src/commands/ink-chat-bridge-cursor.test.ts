import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';
import { createInkChatBridgeCore, handleInput, type InkChatBridgeCore } from './ink-chat-bridge.js';

function makeKey(overrides: Partial<Key> = {}): Key {
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

function nextEvent(core: InkChatBridgeCore): unknown {
    return core.eventQueue.shift();
}

describe('ink chat bridge Ctrl+Left/Ctrl+Right word navigation', () => {
    it('moves the cursor to the start of the previous word on Ctrl+Left', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'hello world', makeKey());
        expect(core.inputBuffer).toBe('hello world');
        expect(core.cursorPosition).toBe(11);

        handleInput(core, '', makeKey({ ctrl: true, leftArrow: true }));
        expect(core.cursorPosition).toBe(6);
    });

    it('moves the cursor to an earlier word on a second Ctrl+Left', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'hello world', makeKey());
        handleInput(core, '', makeKey({ ctrl: true, leftArrow: true }));
        expect(core.cursorPosition).toBe(6);

        handleInput(core, '', makeKey({ ctrl: true, leftArrow: true }));
        expect(core.cursorPosition).toBe(0);
    });

    it('keeps the cursor at 0 when Ctrl+Left is pressed at the start', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'hello world', makeKey());
        handleInput(core, '', makeKey({ ctrl: true, leftArrow: true }));
        handleInput(core, '', makeKey({ ctrl: true, leftArrow: true }));
        expect(core.cursorPosition).toBe(0);

        handleInput(core, '', makeKey({ ctrl: true, leftArrow: true }));
        expect(core.cursorPosition).toBe(0);
    });

    it('keeps the cursor at the end when Ctrl+Right is pressed at the end', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'hello', makeKey());
        expect(core.cursorPosition).toBe(5);

        handleInput(core, '', makeKey({ ctrl: true, rightArrow: true }));
        expect(core.cursorPosition).toBe(5);
    });

    it('moves the cursor past the current word and trailing space on Ctrl+Right', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'hello world', makeKey());
        handleInput(core, '', makeKey({ ctrl: true, leftArrow: true }));
        handleInput(core, '', makeKey({ ctrl: true, leftArrow: true }));
        expect(core.cursorPosition).toBe(0);

        handleInput(core, '', makeKey({ ctrl: true, rightArrow: true }));
        expect(core.cursorPosition).toBe(6);
    });

    it('deletes the character before the cursor on Backspace', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'hello world', makeKey());
        handleInput(core, '', makeKey({ ctrl: true, leftArrow: true }));
        expect(core.cursorPosition).toBe(6);

        handleInput(core, '', makeKey({ backspace: true }));
        expect(core.inputBuffer).toBe('helloworld');
        expect(core.cursorPosition).toBe(5);
    });

    it('does nothing on Backspace when the cursor is at the start', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'hello', makeKey());
        handleInput(core, '', makeKey({ ctrl: true, leftArrow: true }));
        expect(core.cursorPosition).toBe(0);

        handleInput(core, '', makeKey({ backspace: true }));
        expect(core.inputBuffer).toBe('hello');
        expect(core.cursorPosition).toBe(0);
    });

    it('inserts typed text at the cursor position rather than the end', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'hello world', makeKey());
        handleInput(core, '', makeKey({ ctrl: true, leftArrow: true }));
        expect(core.cursorPosition).toBe(6);

        handleInput(core, 'X', makeKey());
        expect(core.inputBuffer).toBe('hello Xworld');
        expect(core.cursorPosition).toBe(7);
    });

    it('inserts a newline at the cursor on Shift+Enter', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'hello world', makeKey());
        handleInput(core, '', makeKey({ ctrl: true, leftArrow: true }));
        expect(core.cursorPosition).toBe(6);

        handleInput(core, '\r', makeKey({ shift: true, return: true }));
        expect(core.inputBuffer).toBe('hello \nworld');
        expect(core.cursorPosition).toBe(7);
        expect(nextEvent(core)).toBeUndefined();
    });

    it('resets cursorPosition to 0 on Enter submit', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'hello', makeKey());
        expect(core.cursorPosition).toBe(5);

        handleInput(core, '\r', makeKey({ return: true }));
        expect(core.inputBuffer).toBe('');
        expect(core.cursorPosition).toBe(0);
        expect(nextEvent(core)).toEqual({ type: 'line', value: 'hello' });
    });

    it('publishes cursorPosition through the snapshot', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'hi', makeKey());
        expect(core.snapshot.cursorPosition).toBe(2);

        handleInput(core, '', makeKey({ ctrl: true, leftArrow: true }));
        expect(core.snapshot.cursorPosition).toBe(0);

        handleInput(core, '', makeKey({ ctrl: true, rightArrow: true }));
        expect(core.snapshot.cursorPosition).toBe(2);
    });

    it('moves the cursor to the end of a recalled history entry', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'remembered prompt\r', makeKey({ return: true }));
        expect(core.cursorPosition).toBe(0);

        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.inputBuffer).toBe('remembered prompt');
        expect(core.cursorPosition).toBe(17);
    });
});
