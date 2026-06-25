/**
 * Test seam: Ctrl+R (enter rename mode) lives in the exported
 * `bridgeTextareaKeyDown`; once `core.renameModeActive` is true the textarea is
 * blurred and subsequent keystrokes (typing, Enter, Esc, Ctrl+C, Backspace)
 * flow through the exported `handleInput`, which dispatches to the rename
 * overlay handler. These tests enter rename via the textarea keyDown and then
 * drive the rename buffer through `handleInput`. Raw character input at idle
 * is native textarea behavior (not asserted).
 */
import type { InkKeyShape } from './opentui-chat-bridge.js';
import { describe, expect, it, vi } from 'vitest';
import {
    bridgeContentChange,
    bridgeTextareaKeyDown,
    createOpenTuiChatBridgeCore,
    handleInput,
    type OpenTuiChatBridgeCore,
} from './opentui-chat-bridge.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
    makeKeyEvent,
} from './opentui-chat-bridge-test-support.js';

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

function enterRename(core: OpenTuiChatBridgeCore): void {
    bridgeTextareaKeyDown(
        core,
        makeKeyEvent('r', { ctrl: true }),
        asTextareaRef(createRecordingTextarea()),
        asScrollboxRef(createRecordingScrollbox()),
    );
}

describe('opentui bridge Ctrl+R session rename', () => {
    it('enters rename mode on Ctrl+R with an empty rename buffer', () => {
        const core = createOpenTuiChatBridgeCore();

        enterRename(core);

        expect(core.renameModeActive).toBe(true);
        expect(core.renameBuffer).toBe('');
        expect(core.snapshot.renameModeActive).toBe(true);
        expect(core.snapshot.renameBuffer).toBe('');
    });

    it('accumulates typed text into renameBuffer while in rename mode', () => {
        const core = createOpenTuiChatBridgeCore();
        enterRename(core);

        for (const ch of 'my-session') {
            handleInput(core, ch, makeKey());
        }

        expect(core.renameBuffer).toBe('my-session');
        expect(core.snapshot.renameBuffer).toBe('my-session');
    });

    it('submits the buffer via onRenameSubmit and exits rename mode on Enter', () => {
        const core = createOpenTuiChatBridgeCore();
        const onSubmit = vi.fn();
        core.onRenameSubmit = onSubmit;
        enterRename(core);

        for (const ch of 'my-session') {
            handleInput(core, ch, makeKey());
        }
        handleInput(core, '\r', makeKey({ return: true }));

        expect(onSubmit).toHaveBeenCalledExactlyOnceWith('my-session');
        expect(core.renameModeActive).toBe(false);
        expect(core.renameBuffer).toBe('');
    });

    it('appends text-before-return to renameBuffer on batched Enter input', () => {
        const core = createOpenTuiChatBridgeCore();
        const onSubmit = vi.fn();
        core.onRenameSubmit = onSubmit;
        enterRename(core);

        handleInput(core, 'name\r', makeKey({ return: true }));

        expect(core.renameBuffer).toBe('');
        expect(onSubmit).toHaveBeenCalledExactlyOnceWith('name');
    });

    it('cancels rename mode on Escape without invoking onRenameSubmit', () => {
        const core = createOpenTuiChatBridgeCore();
        const onSubmit = vi.fn();
        core.onRenameSubmit = onSubmit;
        enterRename(core);

        for (const ch of 'draft') {
            handleInput(core, ch, makeKey());
        }
        handleInput(core, '', makeKey({ escape: true }));

        expect(core.renameModeActive).toBe(false);
        expect(core.renameBuffer).toBe('');
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('cancels rename mode on Ctrl+C without invoking onRenameSubmit', () => {
        const core = createOpenTuiChatBridgeCore();
        const onSubmit = vi.fn();
        core.onRenameSubmit = onSubmit;
        enterRename(core);

        for (const ch of 'draft') {
            handleInput(core, ch, makeKey());
        }
        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(core.renameModeActive).toBe(false);
        expect(core.renameBuffer).toBe('');
        expect(onSubmit).not.toHaveBeenCalled();
    });

    it('does not enqueue an interrupt event on Ctrl+C while in rename mode', () => {
        const core = createOpenTuiChatBridgeCore();
        enterRename(core);

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toBeUndefined();
    });

    it('removes the last char from renameBuffer on Backspace', () => {
        const core = createOpenTuiChatBridgeCore();
        enterRename(core);

        for (const ch of 'hello') {
            handleInput(core, ch, makeKey());
        }
        handleInput(core, '', makeKey({ backspace: true }));

        expect(core.renameBuffer).toBe('hell');
    });

    it('is a no-op on Backspace when renameBuffer is empty', () => {
        const core = createOpenTuiChatBridgeCore();
        enterRename(core);

        handleInput(core, '', makeKey({ backspace: true }));

        expect(core.renameBuffer).toBe('');
        expect(core.renameModeActive).toBe(true);
    });

    it('enters rename mode from normal idle state (no terminal reverse-i-search conflict)', () => {
        const core = createOpenTuiChatBridgeCore();

        enterRename(core);

        expect(core.renameModeActive).toBe(true);
        expect(core.inputBuffer).toBe('');
    });

    it('does not clear the mirrored input buffer when entering rename mode', () => {
        const core = createOpenTuiChatBridgeCore();
        bridgeContentChange(core, 'hello');

        enterRename(core);

        expect(core.renameModeActive).toBe(true);
        expect(core.inputBuffer).toBe('hello');
    });

    it('does not enqueue an interrupt or line event on Ctrl+R', () => {
        const core = createOpenTuiChatBridgeCore();

        enterRename(core);

        expect(nextEvent(core)).toBeUndefined();
    });

    it('does not invoke onRenameSubmit on Enter with an empty rename buffer', () => {
        const core = createOpenTuiChatBridgeCore();
        const onSubmit = vi.fn();
        core.onRenameSubmit = onSubmit;
        enterRename(core);

        handleInput(core, '\r', makeKey({ return: true }));

        expect(onSubmit).not.toHaveBeenCalled();
        expect(core.renameModeActive).toBe(false);
    });

    it('is a no-op on renameModeActive for a plain r (no ctrl) at idle — raw typing is native', () => {
        const core = createOpenTuiChatBridgeCore();

        bridgeTextareaKeyDown(
            core,
            makeKeyEvent('r'),
            asTextareaRef(createRecordingTextarea()),
            asScrollboxRef(createRecordingScrollbox()),
        );

        expect(core.renameModeActive).toBe(false);
        expect(core.inputBuffer).toBe('');
    });
});
