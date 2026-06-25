/**
 * Test seam: Ctrl+E (external editor) lives in the exported
 * `bridgeTextareaKeyDown`, which delegates to the exported `editorControls`
 * (spyable) and rewrites the buffer through the textarea ref
 * (`setText` + `gotoBufferEnd`). Drives Ctrl+E via a fake KeyEvent + recording
 * `TextareaLike` and asserts the textarea was rewritten (NOT core.inputBuffer
 * as the editing source of truth — though the mirror is also updated).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    bridgeTextareaKeyDown,
    createOpenTuiChatBridgeCore,
    editorControls,
} from './opentui-chat-bridge.js';
import { existsSync, writeFileSync } from 'node:fs';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
    makeKeyEvent,
    type RecordingTextarea,
} from './opentui-chat-bridge-test-support.js';

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

function scrollbox() {
    return asScrollboxRef(createRecordingScrollbox());
}

describe('opentui bridge Ctrl+E external editor via bridgeTextareaKeyDown', () => {
    afterEach(() => {
        vi.restoreAllMocks();
        vi.unstubAllEnvs();
    });

    it('calls runEditor with the VISUAL editor and a temp file path on Ctrl+E', () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue('code --wait');
        const { spy } = mockEditorReturning('edited');
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('draft');

        bridgeTextareaKeyDown(core, makeKeyEvent('e', { ctrl: true }), asTextareaRef(textarea), scrollbox());

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
        const core = createOpenTuiChatBridgeCore();

        bridgeTextareaKeyDown(core, makeKeyEvent('e', { ctrl: true }), asTextareaRef(createRecordingTextarea('d')), scrollbox());

        expect(spy).toHaveBeenCalledWith('nano', expect.stringMatching(/mctrl-edit-.*\.md/));
    });

    it('writes a guidance message when no editor is set', () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue(undefined);
        const runSpy = vi.spyOn(editorControls, 'runEditor');
        const core = createOpenTuiChatBridgeCore();

        bridgeTextareaKeyDown(core, makeKeyEvent('e', { ctrl: true }), asTextareaRef(createRecordingTextarea('d')), scrollbox());

        expect(core.outputText).toContain('No editor set');
        expect(runSpy).not.toHaveBeenCalled();
    });

    it('rewrites the textarea with the edited file content via setText after the editor returns', () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue('vim');
        mockEditorReturning('line one\nline two\n');
        const core = createOpenTuiChatBridgeCore();
        const textarea: RecordingTextarea = createRecordingTextarea('original');

        bridgeTextareaKeyDown(core, makeKeyEvent('e', { ctrl: true }), asTextareaRef(textarea), scrollbox());

        expect(textarea.setTextCalls).toEqual(['line one\nline two\n']);
        expect(textarea.plainText).toBe('line one\nline two\n');
        // The mirror is updated too so menus/history stay consistent.
        expect(core.inputBuffer).toBe('line one\nline two\n');
    });

    it('moves the textarea cursor to the end of the new buffer via gotoBufferEnd after an external edit', () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue('vim');
        mockEditorReturning('hello world');
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('hi');

        bridgeTextareaKeyDown(core, makeKeyEvent('e', { ctrl: true }), asTextareaRef(textarea), scrollbox());

        expect(textarea.gotoBufferEndCount).toBe(1);
        expect(textarea.cursorOffset).toBe('hello world'.length);
    });

    it('cleans up the temp file after editing', () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue('vim');
        const { capturedPath } = mockEditorReturning('edited');
        const core = createOpenTuiChatBridgeCore();

        bridgeTextareaKeyDown(core, makeKeyEvent('e', { ctrl: true }), asTextareaRef(createRecordingTextarea('d')), scrollbox());

        const path = capturedPath();
        expect(path.length).toBeGreaterThan(0);
        expect(existsSync(path)).toBe(false);
    });

    it('prefers VISUAL over EDITOR when both are set', () => {
        vi.stubEnv('VISUAL', 'emacs');
        vi.stubEnv('EDITOR', 'pico');
        const runSpy = vi.spyOn(editorControls, 'runEditor').mockImplementation(() => {});
        const core = createOpenTuiChatBridgeCore();

        bridgeTextareaKeyDown(core, makeKeyEvent('e', { ctrl: true }), asTextareaRef(createRecordingTextarea('d')), scrollbox());

        expect(runSpy).toHaveBeenCalledWith('emacs', expect.stringMatching(/mctrl-edit-.*\.md/));
    });

    it('does not enqueue a chat event on Ctrl+E', () => {
        vi.spyOn(editorControls, 'resolveEditor').mockReturnValue('vim');
        mockEditorReturning('x');
        const core = createOpenTuiChatBridgeCore();

        bridgeTextareaKeyDown(core, makeKeyEvent('e', { ctrl: true }), asTextareaRef(createRecordingTextarea('d')), scrollbox());

        expect(core.eventQueue.shift()).toBeUndefined();
    });

    it('is a no-op on the buffer for a plain e (no ctrl) — raw typing is native textarea behavior', () => {
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('');

        bridgeTextareaKeyDown(core, makeKeyEvent('e'), asTextareaRef(textarea), scrollbox());

        expect(textarea.setTextCalls).toEqual([]);
        expect(core.eventQueue.shift()).toBeUndefined();
    });
});
