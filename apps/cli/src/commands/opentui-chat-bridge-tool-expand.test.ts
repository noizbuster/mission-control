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

describe('ink chat bridge Ctrl+O tool output expand/collapse toggle', () => {
    it('initializes toolOutputExpanded to false', () => {
        const core = createOpenTuiChatBridgeCore();

        expect(core.toolOutputExpanded).toBe(false);
        expect(core.snapshot.toolOutputExpanded).toBe(false);
    });

    it('toggles toolOutputExpanded to true on Ctrl+O', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'o', makeKey({ ctrl: true }));

        expect(core.toolOutputExpanded).toBe(true);
    });

    it('toggles toolOutputExpanded back to false on second Ctrl+O', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'o', makeKey({ ctrl: true }));
        handleInput(core, 'o', makeKey({ ctrl: true }));

        expect(core.toolOutputExpanded).toBe(false);
    });

    it('publishes the new toolOutputExpanded value through the snapshot', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'o', makeKey({ ctrl: true }));

        expect(core.snapshot.toolOutputExpanded).toBe(true);
    });

    it('does not enqueue an event on Ctrl+O', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'o', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toBeUndefined();
    });

    it('appends o to the input buffer when ctrl is not held', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'o', makeKey());

        expect(core.inputBuffer).toBe('o');
        expect(core.cursorPosition).toBe(1);
        expect(core.toolOutputExpanded).toBe(false);
    });
});
