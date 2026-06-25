/**
 * Test seam: Ctrl+Z (suspend) lives in the exported `bridgeTextareaKeyDown`,
 * which delegates to the exported `suspendControls` (spyable). Drives Ctrl+Z
 * via a fake KeyEvent and asserts the suspend signal / Windows message /
 * event-queue invariants. Raw character input is native textarea behavior.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    bridgeTextareaKeyDown,
    createOpenTuiChatBridgeCore,
    suspendControls,
} from './opentui-chat-bridge.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
    makeKeyEvent,
} from './opentui-chat-bridge-test-support.js';

function setup() {
    const core = createOpenTuiChatBridgeCore();
    const textareaRef = asTextareaRef(createRecordingTextarea());
    const scrollboxRef = asScrollboxRef(createRecordingScrollbox());
    return { core, textareaRef, scrollboxRef };
}

describe('opentui bridge Ctrl+Z suspend via bridgeTextareaKeyDown', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('sends SIGTSTP to the current process on Ctrl+Z (POSIX)', () => {
        const killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
        const { core, textareaRef, scrollboxRef } = setup();

        bridgeTextareaKeyDown(core, makeKeyEvent('z', { ctrl: true }), textareaRef, scrollboxRef);

        expect(killSpy).toHaveBeenCalledWith(process.pid, 'SIGTSTP');
    });

    it('writes an unsupported message on Ctrl+Z on Windows', () => {
        vi.spyOn(suspendControls, 'isWindowsPlatform').mockReturnValue(true);
        vi.spyOn(process, 'kill').mockReturnValue(true);
        const { core, textareaRef, scrollboxRef } = setup();

        bridgeTextareaKeyDown(core, makeKeyEvent('z', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.outputText).toContain('Suspend not supported on Windows.');
    });

    it('does not enqueue an event on Ctrl+Z', () => {
        vi.spyOn(process, 'kill').mockReturnValue(true);
        const { core, textareaRef, scrollboxRef } = setup();

        bridgeTextareaKeyDown(core, makeKeyEvent('z', { ctrl: true }), textareaRef, scrollboxRef);

        expect(core.eventQueue.shift()).toBeUndefined();
    });

    it('does not clear the mirrored input buffer on Ctrl+Z', () => {
        vi.spyOn(process, 'kill').mockReturnValue(true);
        const core = createOpenTuiChatBridgeCore();
        const textareaRef = asTextareaRef(createRecordingTextarea('hello'));
        // Mirror the textarea text into the core (as bridgeContentChange would).
        core.inputBuffer = 'hello';

        bridgeTextareaKeyDown(core, makeKeyEvent('z', { ctrl: true }), textareaRef, asScrollboxRef(createRecordingScrollbox()));

        expect(core.inputBuffer).toBe('hello');
    });

    it('calls preventDefault on the Ctrl+Z KeyEvent', () => {
        vi.spyOn(process, 'kill').mockReturnValue(true);
        const { core, textareaRef, scrollboxRef } = setup();
        const key = makeKeyEvent('z', { ctrl: true });

        bridgeTextareaKeyDown(core, key, textareaRef, scrollboxRef);

        expect(key.defaultPrevented).toBe(true);
    });

    it('is a no-op on the buffer for a plain z (no ctrl) — raw typing is native textarea behavior', () => {
        const { core, textareaRef, scrollboxRef } = setup();

        bridgeTextareaKeyDown(core, makeKeyEvent('z'), textareaRef, scrollboxRef);

        expect(core.inputBuffer).toBe('');
        expect(core.eventQueue.shift()).toBeUndefined();
    });
});
