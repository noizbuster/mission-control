import type { Key } from 'ink';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createInkChatBridgeCore, editorControls, handleInput, type InkChatBridgeCore } from './ink-chat-bridge.js';
import { existsSync, writeFileSync } from 'node:fs';

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

function mockEditorReturning(content: string): {
    spy: ReturnType<typeof vi.spyOn>;
    capturedPath: () => string;
} {
    let path = '';
    const spy = vi.spyOn(editorControls, 'runEditor').mockImplementation((_editor, filePath) => {
        path = filePath;
        writeFileSync(filePath, content, 'utf-8');
    });
    return { spy, capturedPath: () => path };
}

describe('ink chat bridge Ctrl+E external editor', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('calls runEditor with the VISUAL editor and a temp file path on Ctrl+E', () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue('code --wait');
        const { spy } = mockEditorReturning('edited');

        const core = createInkChatBridgeCore();
        handleInput(core, 'e', makeKey({ ctrl: true }));

        expect(spy).toHaveBeenCalledTimes(1);
        const [editorArg, pathArg] = spy.mock.calls[0] ?? [];
        expect(editorArg).toBe('code --wait');
        expect(typeof pathArg).toBe('string');
        expect(pathArg).toContain('mctrl-edit-');
        expect(pathArg).toMatch(/\.md$/);
    });

    it('calls runEditor with EDITOR when VISUAL is not set', () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue('nano');
        const { spy } = mockEditorReturning('x');

        const core = createInkChatBridgeCore();
        handleInput(core, 'e', makeKey({ ctrl: true }));

        expect(spy).toHaveBeenCalledWith('nano', expect.stringMatching(/mctrl-edit-.*\.md/));
    });

    it('writes a guidance message when no editor is set', () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue(undefined);
        const runSpy = vi.spyOn(editorControls, 'runEditor');

        const core = createInkChatBridgeCore();
        handleInput(core, 'e', makeKey({ ctrl: true }));

        expect(core.outputText).toContain('No editor set');
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('replaces inputBuffer with the edited file content after the editor returns', () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue('vim');
        mockEditorReturning('line one\nline two\n');

        const core = createInkChatBridgeCore();
        core.inputBuffer = 'original';
        core.cursorPosition = 8;

        handleInput(core, 'e', makeKey({ ctrl: true }));

        expect(core.inputBuffer).toBe('line one\nline two\n');
    });

    it('moves cursor to the end of the new buffer after an external edit', () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue('vim');
        mockEditorReturning('hello world');

        const core = createInkChatBridgeCore();
        core.inputBuffer = 'hi';
        core.cursorPosition = 0;

        handleInput(core, 'e', makeKey({ ctrl: true }));

        expect(core.inputBuffer).toBe('hello world');
        expect(core.cursorPosition).toBe('hello world'.length);
    });

    it('cleans up the temp file after editing', () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue('vim');
        const { capturedPath } = mockEditorReturning('edited');

        const core = createInkChatBridgeCore();
        handleInput(core, 'e', makeKey({ ctrl: true }));

        const path = capturedPath();
        expect(path.length).toBeGreaterThan(0);
        expect(existsSync(path)).toBe(false);
    });

    it('appends e to the input buffer when ctrl is not held (regression)', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, 'e', makeKey());

        expect(core.inputBuffer).toBe('e');
        expect(core.cursorPosition).toBe(1);
    });

    it('prefers VISUAL over EDITOR when both are set', () => {
        vi.stubEnv('VISUAL', 'emacs');
        vi.stubEnv('EDITOR', 'pico');
        const runSpy = vi.spyOn(editorControls, 'runEditor').mockImplementation(() => {});

        const core = createInkChatBridgeCore();
        handleInput(core, 'e', makeKey({ ctrl: true }));

        expect(runSpy).toHaveBeenCalledWith('emacs', expect.stringMatching(/mctrl-edit-.*\.md/));
    });

    it('does not enqueue a chat event on Ctrl+E', () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue('vim');
        mockEditorReturning('x');

        const core = createInkChatBridgeCore();
        handleInput(core, 'e', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toBeUndefined();
    });
});
