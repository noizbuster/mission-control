import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';
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

function enterRenameMode(core: InkChatBridgeCore): void {
    handleInput(core, 'r', makeKey({ ctrl: true }));
}

describe('ink chat bridge Ctrl+R session rename', () => {
    it('enters rename mode on Ctrl+R with an empty rename buffer', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'r', makeKey({ ctrl: true }));

        expect(core.renameModeActive).toBe(true);
        expect(core.renameBuffer).toBe('');
        expect(core.snapshot.renameModeActive).toBe(true);
        expect(core.snapshot.renameBuffer).toBe('');
    });

    it('accumulates typed text into renameBuffer while in rename mode', () => {
        const core = createInkChatBridgeCore();
        enterRenameMode(core);

        for (const ch of 'my-session') {
            handleInput(core, ch, makeKey());
        }

        expect(core.renameBuffer).toBe('my-session');
        expect(core.snapshot.renameBuffer).toBe('my-session');
    });

    it('submits the buffer via onRenameSubmit and exits rename mode on Enter', () => {
        const core = createInkChatBridgeCore();
        const onSubmit = vi.fn();
        core.onRenameSubmit = onSubmit;
        enterRenameMode(core);

        for (const ch of 'my-session') {
            handleInput(core, ch, makeKey());
        }
        handleInput(core, '\r', makeKey({ return: true }));

        expect(onSubmit).toHaveBeenCalledExactlyOnceWith('my-session');
        expect(core.renameModeActive).toBe(false);
        expect(core.renameBuffer).toBe('');
    });

    it('appends text-before-return to renameBuffer on batched Enter input', () => {
        const core = createInkChatBridgeCore();
        const onSubmit = vi.fn();
        core.onRenameSubmit = onSubmit;
        enterRenameMode(core);

        handleInput(core, 'name\r', makeKey({ return: true }));

        expect(core.renameBuffer).toBe('');
        expect(onSubmit).toHaveBeenCalledExactlyOnceWith('name');
    });

    it('cancels rename mode on Escape without invoking onRenameSubmit', () => {
        const core = createInkChatBridgeCore();
        const onSubmit = vi.fn();
        core.onRenameSubmit = onSubmit;
        enterRenameMode(core);

        for (const ch of 'draft') {
            handleInput(core, ch, makeKey());
        }
        handleInput(core, '', makeKey({ escape: true }));

        expect(core.renameModeActive).toBe(false);
        expect(core.renameBuffer).toBe('');
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('cancels rename mode on Ctrl+C without invoking onRenameSubmit', () => {
        const core = createInkChatBridgeCore();
        const onSubmit = vi.fn();
        core.onRenameSubmit = onSubmit;
        enterRenameMode(core);

        for (const ch of 'draft') {
            handleInput(core, ch, makeKey());
        }
        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(core.renameModeActive).toBe(false);
        expect(core.renameBuffer).toBe('');
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not enqueue an interrupt event on Ctrl+C while in rename mode', () => {
        const core = createInkChatBridgeCore();
        enterRenameMode(core);

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toBeUndefined();
    });

    it('removes the last char from renameBuffer on Backspace', () => {
        const core = createInkChatBridgeCore();
        enterRenameMode(core);

        for (const ch of 'hello') {
            handleInput(core, ch, makeKey());
        }
        handleInput(core, '', makeKey({ backspace: true }));

        expect(core.renameBuffer).toBe('hell');
    });

    it('is a no-op on Backspace when renameBuffer is empty', () => {
        const core = createInkChatBridgeCore();
        enterRenameMode(core);

        handleInput(core, '', makeKey({ backspace: true }));

        expect(core.renameBuffer).toBe('');
        expect(core.renameModeActive).toBe(true);
    });

    it('enters rename mode from normal idle state (no terminal reverse-i-search conflict)', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'r', makeKey({ ctrl: true }));

        expect(core.renameModeActive).toBe(true);
        expect(core.inputBuffer).toBe('');
    });

    it('does not clear the existing input buffer when entering rename mode', () => {
        const core = createInkChatBridgeCore();
        handleInput(core, 'hello', makeKey());

        handleInput(core, 'r', makeKey({ ctrl: true }));

        expect(core.renameModeActive).toBe(true);
        expect(core.inputBuffer).toBe('hello');
        expect(core.cursorPosition).toBe(5);
    });

    it('appends r to the input buffer when ctrl is not held (regression)', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'r', makeKey());

        expect(core.inputBuffer).toBe('r');
        expect(core.cursorPosition).toBe(1);
        expect(core.renameModeActive).toBe(false);
    });

    it('does not enqueue an interrupt or line event on Ctrl+R', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'r', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toBeUndefined();
    });

    it('does not invoke onRenameSubmit on Enter with an empty rename buffer', () => {
        const core = createInkChatBridgeCore();
        const onSubmit = vi.fn();
        core.onRenameSubmit = onSubmit;
        enterRenameMode(core);

        handleInput(core, '\r', makeKey({ return: true }));

        expect(onSubmit).not.toHaveBeenCalled();
        expect(core.renameModeActive).toBe(false);
    });
});
