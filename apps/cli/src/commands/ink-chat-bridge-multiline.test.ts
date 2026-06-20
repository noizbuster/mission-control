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

describe('ink chat bridge Shift+Enter multi-line input', () => {
    it('submits a multi-line buffer after Shift+Enter then plain Enter', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'hello\r', makeKey({ shift: true, return: true }));
        expect(core.inputBuffer).toBe('hello\n');

        handleInput(core, 'world\r', makeKey({ return: true }));
        expect(core.inputBuffer).toBe('');
        expect(nextEvent(core)).toEqual({ type: 'line', value: 'hello\nworld' });
    });

    it('still submits single-line input on plain Enter without shift', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'hello\r', makeKey({ return: true }));

        expect(core.inputBuffer).toBe('');
        expect(nextEvent(core)).toEqual({ type: 'line', value: 'hello' });
    });

    it('appends a newline on Shift+Enter with an empty buffer', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, '\r', makeKey({ shift: true, return: true }));

        expect(core.inputBuffer).toBe('\n');
        expect(nextEvent(core)).toBeUndefined();
    });

    it('extracts leading text when Shift+Enter batches text and return without key.return', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'hello\r', makeKey({ shift: true }));

        expect(core.inputBuffer).toBe('hello\n');
        expect(nextEvent(core)).toBeUndefined();
    });

    it('accumulates separate keystrokes before a Shift+Enter newline', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'h', makeKey());
        handleInput(core, 'i', makeKey());
        handleInput(core, '\r', makeKey({ shift: true, return: true }));

        expect(core.inputBuffer).toBe('hi\n');
        expect(nextEvent(core)).toBeUndefined();
    });

    it('echoes multi-line user input to outputText on submit', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'line one\r', makeKey({ shift: true, return: true }));
        handleInput(core, 'line two\r', makeKey({ return: true }));

        expect(core.outputText).toBe('You: line one\nline two\n');
    });

    it('does not submit on Shift+Enter and leaves a pending line in the buffer', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'draft\r', makeKey({ shift: true, return: true }));

        expect(core.eventQueue.length).toBe(0);
        expect(core.inputBuffer).toBe('draft\n');
    });
});
