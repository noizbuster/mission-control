import type { InkKeyShape } from './opentui-chat-bridge.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createOpenTuiChatBridgeCore, handleInput, type OpenTuiChatBridgeCore, suspendControls } from './opentui-chat-bridge.js';

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

describe('ink chat bridge Ctrl+Z suspend', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('sends SIGTSTP to the current process on Ctrl+Z (POSIX)', () => {
        const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'z', makeKey({ ctrl: true }));

        expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTSTP');
    });

    it('writes an unsupported message on Ctrl+Z on Windows', () => {
        vi.spyOn(suspendControls, 'isWindowsPlatform').mockReturnValue(true);
        vi.spyOn(process, 'kill').mockReturnValue(true);
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'z', makeKey({ ctrl: true }));

        expect(core.outputText).toContain('Suspend not supported on Windows.');
    });

    it('does not enqueue an event on Ctrl+Z', () => {
        vi.spyOn(process, 'kill').mockReturnValue(true);
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'z', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toBeUndefined();
    });

    it('does not clear the input buffer on Ctrl+Z', () => {
        vi.spyOn(process, 'kill').mockReturnValue(true);
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'hello', makeKey());
        handleInput(core, 'z', makeKey({ ctrl: true }));

        expect(core.inputBuffer).toBe('hello');
        expect(core.cursorPosition).toBe(5);
    });

    it('appends z to the input buffer when ctrl is not held', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'z', makeKey());

        expect(core.inputBuffer).toBe('z');
        expect(core.cursorPosition).toBe(1);
    });
});
