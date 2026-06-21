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

describe('ink chat bridge Ctrl+O tool output expand/collapse toggle', () => {
    it('initializes toolOutputExpanded to false', () => {
        const core = createInkChatBridgeCore();

        expect(core.toolOutputExpanded).toBe(false);
        expect(core.snapshot.toolOutputExpanded).toBe(false);
    });

    it('toggles toolOutputExpanded to true on Ctrl+O', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'o', makeKey({ ctrl: true }));

        expect(core.toolOutputExpanded).toBe(true);
    });

    it('toggles toolOutputExpanded back to false on second Ctrl+O', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'o', makeKey({ ctrl: true }));
        handleInput(core, 'o', makeKey({ ctrl: true }));

        expect(core.toolOutputExpanded).toBe(false);
    });

    it('publishes the new toolOutputExpanded value through the snapshot', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'o', makeKey({ ctrl: true }));

        expect(core.snapshot.toolOutputExpanded).toBe(true);
    });

    it('does not enqueue an event on Ctrl+O', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'o', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toBeUndefined();
    });

    it('appends o to the input buffer when ctrl is not held', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'o', makeKey());

        expect(core.inputBuffer).toBe('o');
        expect(core.cursorPosition).toBe(1);
        expect(core.toolOutputExpanded).toBe(false);
    });
});
