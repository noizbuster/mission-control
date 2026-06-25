/**
 * Test seam: Ctrl+V (clipboard image paste) lives in the exported
 * `bridgeTextareaKeyDown`, which delegates to the exported
 * `clipboardImageControls` (spyable) and inserts the path through the textarea
 * ref (`insertText`). Drives Ctrl+V via a fake KeyEvent + recording
 * `TextareaLike` and asserts `insertText` was called with the path (the
 * textarea owns the buffer, range-replace semantics are native).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    bridgeTextareaKeyDown,
    clipboardImageControls,
    createOpenTuiChatBridgeCore,
} from './opentui-chat-bridge.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
    makeKeyEvent,
} from './opentui-chat-bridge-test-support.js';

// Partial mock: override execSync (used by readClipboardImage) to throw,
// simulating missing clipboard binaries, while keeping the rest of
// node:child_process (execFile, etc.) intact for transitive importers.
vi.mock('node:child_process', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:child_process')>();
    return {
        ...actual,
        execSync: vi.fn(() => {
            throw new Error('spawn ENOENT');
        }),
    };
});

function scrollbox() {
    return asScrollboxRef(createRecordingScrollbox());
}

describe('opentui bridge Ctrl+V image paste via bridgeTextareaKeyDown', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('inserts the clipboard image file path via textarea insertText on Ctrl+V', () => {
        vi.spyOn(clipboardImageControls, 'readClipboardImage').mockReturnValue({
            path: '/tmp/mctrl-paste-1234567890.png',
        });
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea();

        bridgeTextareaKeyDown(core, makeKeyEvent('v', { ctrl: true }), asTextareaRef(textarea), scrollbox());

        expect(textarea.insertTextCalls).toEqual(['/tmp/mctrl-paste-1234567890.png ']);
        expect(textarea.plainText).toContain('/tmp/mctrl-paste-1234567890.png');
    });

    it('inserts the path at the cursor offset via insertText (range-replace, not buffer-end rewrite)', () => {
        vi.spyOn(clipboardImageControls, 'readClipboardImage').mockReturnValue({
            path: '/tmp/img.png',
        });
        const core = createOpenTuiChatBridgeCore();
        // Cursor sits mid-buffer at offset 5; insertText inserts at cursorOffset.
        const textarea = createRecordingTextarea('hello world', 5);

        bridgeTextareaKeyDown(core, makeKeyEvent('v', { ctrl: true }), asTextareaRef(textarea), scrollbox());

        expect(textarea.insertTextCalls).toEqual(['/tmp/img.png ']);
        expect(textarea.plainText).toBe('hello/tmp/img.png  world');
    });

    it('leaves the textarea unchanged when the clipboard has no image', () => {
        vi.spyOn(clipboardImageControls, 'readClipboardImage').mockReturnValue(undefined);
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea('existing text');

        bridgeTextareaKeyDown(core, makeKeyEvent('v', { ctrl: true }), asTextareaRef(textarea), scrollbox());

        expect(textarea.insertTextCalls).toEqual([]);
        expect(textarea.plainText).toBe('existing text');
    });

    it('does not enqueue an event or write an error when no image is present', () => {
        vi.spyOn(clipboardImageControls, 'readClipboardImage').mockReturnValue(undefined);
        const core = createOpenTuiChatBridgeCore();

        bridgeTextareaKeyDown(core, makeKeyEvent('v', { ctrl: true }), asTextareaRef(createRecordingTextarea()), scrollbox());

        expect(core.eventQueue.shift()).toBeUndefined();
        expect(core.outputText).toBe('');
    });

    it('returns undefined when clipboard tools are not installed (no crash)', () => {
        // execSync is mocked at module level to throw (simulating missing
        // xclip/wl-paste/pngpaste). The real readClipboardImage must swallow
        // that and return undefined.
        const result = clipboardImageControls.readClipboardImage();

        expect(result).toBeUndefined();
    });

    it('is a no-op on the buffer for a plain v (no ctrl) — raw typing is native textarea behavior', () => {
        const core = createOpenTuiChatBridgeCore();
        const textarea = createRecordingTextarea();

        bridgeTextareaKeyDown(core, makeKeyEvent('v'), asTextareaRef(textarea), scrollbox());

        expect(textarea.insertTextCalls).toEqual([]);
        expect(core.eventQueue.shift()).toBeUndefined();
    });
});
