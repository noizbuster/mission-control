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

describe('ink chat bridge Ctrl+T thinking toggle', () => {
    it('initializes showThinking to true', () => {
        const core = createOpenTuiChatBridgeCore();

        expect(core.showThinking).toBe(true);
        expect(core.snapshot.showThinking).toBe(true);
    });

    it('toggles showThinking to false on Ctrl+T', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 't', makeKey({ ctrl: true }));

        expect(core.showThinking).toBe(false);
    });

    it('toggles showThinking back to true on second Ctrl+T', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 't', makeKey({ ctrl: true }));
        handleInput(core, 't', makeKey({ ctrl: true }));

        expect(core.showThinking).toBe(true);
    });

    it('publishes the new showThinking value through the snapshot', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 't', makeKey({ ctrl: true }));

        expect(core.snapshot.showThinking).toBe(false);
    });

    it('does not enqueue an event on Ctrl+T', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 't', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toBeUndefined();
    });

    it('appends t to the input buffer when ctrl is not held', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 't', makeKey());

        expect(core.inputBuffer).toBe('t');
        expect(core.cursorPosition).toBe(1);
        expect(core.showThinking).toBe(true);
    });
});
