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

describe('ink chat bridge workflow menu completion', () => {
    it('completes the selected workflow into the buffer on Enter without submitting', () => {
        const core = createInkChatBridgeCore();
        core.workflowNames = ['default', 'planner', 'runner'];

        handleInput(core, '#', makeKey());
        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '\r', makeKey({ return: true }));

        expect(core.inputBuffer).toBe('#planner ');
        expect(core.cursorPosition).toBe('#planner '.length);
        expect(nextEvent(core)).toBeUndefined();
    });

    it('keeps the default (first) workflow when Enter is pressed without arrow navigation', () => {
        const core = createInkChatBridgeCore();
        core.workflowNames = ['planner', 'runner'];

        handleInput(core, '#', makeKey());
        handleInput(core, '\r', makeKey({ return: true }));

        expect(core.inputBuffer).toBe('#planner ');
        expect(nextEvent(core)).toBeUndefined();
    });

    it('submits the full line on a second Enter after the user types the prompt', () => {
        const core = createInkChatBridgeCore();
        core.workflowNames = ['planner'];

        handleInput(core, '#', makeKey());
        handleInput(core, '\r', makeKey({ return: true }));
        expect(core.inputBuffer).toBe('#planner ');

        handleInput(core, 'ship it', makeKey());
        handleInput(core, '\r', makeKey({ return: true }));

        expect(nextEvent(core)).toEqual({ type: 'line', value: '#planner ship it' });
        expect(core.inputBuffer).toBe('');
    });

    it('submits directly when the prompt was already typed past the workflow name', () => {
        const core = createInkChatBridgeCore();
        core.workflowNames = ['planner'];

        handleInput(core, '#planner ship it', makeKey());
        handleInput(core, '\r', makeKey({ return: true }));

        expect(nextEvent(core)).toEqual({ type: 'line', value: '#planner ship it' });
    });

    it('lets the user filter with a partial query before completing', () => {
        const core = createInkChatBridgeCore();
        core.workflowNames = ['default', 'planner', 'runner'];

        handleInput(core, '#pl', makeKey());
        handleInput(core, '\r', makeKey({ return: true }));

        expect(core.inputBuffer).toBe('#planner ');
        expect(nextEvent(core)).toBeUndefined();
    });

    it('completes the highlighted choice after navigating up', () => {
        const core = createInkChatBridgeCore();
        core.workflowNames = ['default', 'planner', 'runner'];

        handleInput(core, '#', makeKey());
        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '', makeKey({ upArrow: true }));
        handleInput(core, '\r', makeKey({ return: true }));

        expect(core.inputBuffer).toBe('#planner ');
    });
});
