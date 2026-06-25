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

describe('ink chat bridge Shift+Enter multi-line input', () => {
    it('submits a multi-line buffer after Shift+Enter then plain Enter', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'hello\r', makeKey({ shift: true, return: true }));
        expect(core.inputBuffer).toBe('hello\n');

        handleInput(core, 'world\r', makeKey({ return: true }));
        expect(core.inputBuffer).toBe('');
        expect(nextEvent(core)).toEqual({ type: 'line', value: 'hello\nworld' });
    });

    it('still submits single-line input on plain Enter without shift', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'hello\r', makeKey({ return: true }));

        expect(core.inputBuffer).toBe('');
        expect(nextEvent(core)).toEqual({ type: 'line', value: 'hello' });
    });

    it('appends a newline on Shift+Enter with an empty buffer', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, '\r', makeKey({ shift: true, return: true }));

        expect(core.inputBuffer).toBe('\n');
        expect(nextEvent(core)).toBeUndefined();
    });

    it('extracts leading text when Shift+Enter batches text and return without key.return', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'hello\r', makeKey({ shift: true }));

        expect(core.inputBuffer).toBe('hello\n');
        expect(nextEvent(core)).toBeUndefined();
    });

    it('accumulates separate keystrokes before a Shift+Enter newline', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'h', makeKey());
        handleInput(core, 'i', makeKey());
        handleInput(core, '\r', makeKey({ shift: true, return: true }));

        expect(core.inputBuffer).toBe('hi\n');
        expect(nextEvent(core)).toBeUndefined();
    });

    it('echoes multi-line user input to outputText on submit', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'line one\r', makeKey({ shift: true, return: true }));
        handleInput(core, 'line two\r', makeKey({ return: true }));

        expect(core.outputText).toBe('You: line one\nline two\n');
    });

    it('does not submit on Shift+Enter and leaves a pending line in the buffer', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'draft\r', makeKey({ shift: true, return: true }));

        expect(core.eventQueue.length).toBe(0);
        expect(core.inputBuffer).toBe('draft\n');
    });
});

describe('ink chat bridge Alt+Enter multi-line input', () => {
    // Alt+Enter (`\x1b\r`) reaches handleInput with key.return=true and
    // key.meta=true after Ink's parser strips the escape prefix. This is the
    // reliable cross-terminal multi-line trigger — Shift+Enter only fires on
    // kitty-protocol terminals.

    it('appends a newline on Alt+Enter with an empty buffer', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, '\r', makeKey({ meta: true, return: true }));

        expect(core.inputBuffer).toBe('\n');
        expect(core.eventQueue.length).toBe(0);
    });

    it('appends a newline and preserves buffered text on Alt+Enter', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'hello\r', makeKey({ meta: true, return: true }));

        expect(core.inputBuffer).toBe('hello\n');
        expect(core.eventQueue.length).toBe(0);
    });

    it('submits a multi-line buffer after Alt+Enter then plain Enter', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'hello\r', makeKey({ meta: true, return: true }));
        expect(core.inputBuffer).toBe('hello\n');

        handleInput(core, 'world\r', makeKey({ return: true }));
        expect(core.inputBuffer).toBe('');
        expect(nextEvent(core)).toEqual({ type: 'line', value: 'hello\nworld' });
    });

    it('still submits single-line input on plain Enter without alt', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'hello\r', makeKey({ return: true }));

        expect(core.inputBuffer).toBe('');
        expect(nextEvent(core)).toEqual({ type: 'line', value: 'hello' });
    });

    it('echoes multi-line user input to outputText on submit', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'line one\r', makeKey({ meta: true, return: true }));
        handleInput(core, 'line two\r', makeKey({ return: true }));

        expect(core.outputText).toBe('You: line one\nline two\n');
    });
});
