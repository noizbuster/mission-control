import type { Key } from 'ink';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createInkChatBridgeCore, handleInput, type InkChatBridgeCore } from './ink-chat-bridge.js';

const DOUBLE_ESC_ACTION_ENV = 'MCTRL_DOUBLE_ESC_ACTION';

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

function pressEsc(core: InkChatBridgeCore): void {
    handleInput(core, '', makeKey({ escape: true }));
}

describe('ink chat bridge double-Esc configurable action', () => {
    beforeEach(() => {
        vi.stubEnv(DOUBLE_ESC_ACTION_ENV, '');
    });

    afterEach(() => {
        vi.unstubAllEnvs();
        vi.restoreAllMocks();
    });

    it('records the timestamp on single Esc with an empty buffer and does not enqueue an event', () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_000);
        const core = createInkChatBridgeCore();

        pressEsc(core);

        expect(core.lastEscTimestamp).toBe(1_000);
        expect(nextEvent(core)).toBeUndefined();
    });

    it('enqueues an interrupt event on double Esc within the window (default action)', () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100);
        const core = createInkChatBridgeCore();

        pressEsc(core);
        pressEsc(core);

        expect(nextEvent(core)).toEqual({ type: 'interrupt', interruptedPartialInput: false });
    });

    it('does not trigger the action when the second Esc falls outside the window', () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(2_000);
        const core = createInkChatBridgeCore();

        pressEsc(core);
        pressEsc(core);

        expect(nextEvent(core)).toBeUndefined();
        expect(core.lastEscTimestamp).toBe(2_000);
    });

    it('does nothing on double Esc when the action is set to none', () => {
        vi.stubEnv(DOUBLE_ESC_ACTION_ENV, 'none');
        vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100);
        const core = createInkChatBridgeCore();

        pressEsc(core);
        pressEsc(core);

        expect(nextEvent(core)).toBeUndefined();
        expect(core.lastEscTimestamp).toBeUndefined();
    });

    it('enqueues a /tree line event on double Esc when the action is set to tree', () => {
        vi.stubEnv(DOUBLE_ESC_ACTION_ENV, 'tree');
        vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100);
        const core = createInkChatBridgeCore();

        pressEsc(core);
        pressEsc(core);

        expect(nextEvent(core)).toEqual({ type: 'line', value: '/tree' });
    });

    it('clears the input buffer on Esc with a non-empty buffer and skips double-Esc detection', () => {
        const core = createInkChatBridgeCore();
        core.inputBuffer = 'hello world';
        core.cursorPosition = 5;

        pressEsc(core);

        expect(core.inputBuffer).toBe('');
        expect(core.cursorPosition).toBe(0);
        expect(core.lastEscTimestamp).toBeUndefined();
        expect(nextEvent(core)).toBeUndefined();
    });

    it('resets the timestamp after a double Esc so a third Esc does not trigger again immediately', () => {
        vi.spyOn(Date, 'now').mockReturnValueOnce(1_000).mockReturnValueOnce(1_100).mockReturnValueOnce(1_200);
        const core = createInkChatBridgeCore();

        pressEsc(core);
        pressEsc(core);
        pressEsc(core);

        expect(nextEvent(core)).toEqual({ type: 'interrupt', interruptedPartialInput: false });
        expect(nextEvent(core)).toBeUndefined();
        expect(core.lastEscTimestamp).toBe(1_200);
    });

    it('does not trigger double-Esc handling when the model picker is active', () => {
        const core = createInkChatBridgeCore();
        core.modelPickerActive = true;
        const previousTimestamp = 1_000;
        core.lastEscTimestamp = previousTimestamp;

        pressEsc(core);

        expect(core.lastEscTimestamp).toBe(previousTimestamp);
        expect(core.modelPickerActive).toBe(true);
        expect(nextEvent(core)).toBeUndefined();
    });

    it('does not trigger double-Esc handling when rename mode is active (Esc cancels rename)', () => {
        const core = createInkChatBridgeCore();
        const onSubmit = vi.fn();
        core.onRenameSubmit = onSubmit;

        handleInput(core, 'r', makeKey({ ctrl: true }));
        for (const ch of 'draft') {
            handleInput(core, ch, makeKey());
        }

        pressEsc(core);

        expect(core.renameModeActive).toBe(false);
        expect(core.renameBuffer).toBe('');
        expect(onSubmit).not.toHaveBeenCalled();
        expect(core.lastEscTimestamp).toBeUndefined();
        expect(nextEvent(core)).toBeUndefined();
    });
});
