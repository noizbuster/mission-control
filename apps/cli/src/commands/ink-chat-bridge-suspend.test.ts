import type { Key } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInkChatBridgeCore, handleInput, type InkChatBridgeCore, suspendControls } from './ink-chat-bridge.js';

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

describe('ink chat bridge Ctrl+Z suspend', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('sends SIGTSTP to the current process on Ctrl+Z (POSIX)', () => {
        const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
        const core = createInkChatBridgeCore();

        handleInput(core, 'z', makeKey({ ctrl: true }));

        expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTSTP');
    });

    it('writes an unsupported message on Ctrl+Z on Windows', () => {
        vi.spyOn(suspendControls, 'isWindowsPlatform').mockReturnValue(true);
        vi.spyOn(process, 'kill').mockReturnValue(true);
        const core = createInkChatBridgeCore();

        handleInput(core, 'z', makeKey({ ctrl: true }));

        expect(core.outputText).toContain('Suspend not supported on Windows.');
    });

    it('does not enqueue an event on Ctrl+Z', () => {
        vi.spyOn(process, 'kill').mockReturnValue(true);
        const core = createInkChatBridgeCore();

        handleInput(core, 'z', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toBeUndefined();
    });

    it('does not clear the input buffer on Ctrl+Z', () => {
        vi.spyOn(process, 'kill').mockReturnValue(true);
        const core = createInkChatBridgeCore();

        handleInput(core, 'hello', makeKey());
        handleInput(core, 'z', makeKey({ ctrl: true }));

        expect(core.inputBuffer).toBe('hello');
        expect(core.cursorPosition).toBe(5);
    });

    it('appends z to the input buffer when ctrl is not held', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'z', makeKey());

        expect(core.inputBuffer).toBe('z');
        expect(core.cursorPosition).toBe(1);
    });
});
