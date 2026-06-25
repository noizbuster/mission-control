import type { InkKeyShape } from './opentui-chat-bridge.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    clipboardImageControls,
    createOpenTuiChatBridgeCore,
    handleInput,
    type OpenTuiChatBridgeCore,
} from './opentui-chat-bridge.js';

// Module-level mock: execSync throws so the real readClipboardImage
// (invoked in the "tools not installed" case) returns undefined
// regardless of the host platform's clipboard binaries.
vi.mock('node:child_process', () => ({
    execSync: vi.fn(() => {
        throw new Error('spawn ENOENT');
    }),
    spawnSync: vi.fn(),
}));

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

describe('ink chat bridge Ctrl+V image paste', () => {
    afterEach(() => {
        vi.restoreAllMocks();
    });

    it('inserts the clipboard image file path into the input buffer on Ctrl+V', () => {
        vi.spyOn(clipboardImageControls, 'readClipboardImage').mockReturnValue({
            path: '/tmp/mctrl-paste-1234567890.png',
        });
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'v', makeKey({ ctrl: true }));

        expect(core.inputBuffer).toContain('/tmp/mctrl-paste-1234567890.png');
    });

    it('inserts the path at the cursor position when the cursor is mid-buffer', () => {
        vi.spyOn(clipboardImageControls, 'readClipboardImage').mockReturnValue({
            path: '/tmp/img.png',
        });
        const core = createOpenTuiChatBridgeCore();
        core.inputBuffer = 'hello world';
        core.cursorPosition = 5;

        handleInput(core, 'v', makeKey({ ctrl: true }));

        expect(core.inputBuffer).toBe('hello/tmp/img.png  world');
        expect(core.cursorPosition).toBe(5 + '/tmp/img.png '.length);
    });

    it('leaves the input buffer unchanged when the clipboard has no image', () => {
        vi.spyOn(clipboardImageControls, 'readClipboardImage').mockReturnValue(undefined);
        const core = createOpenTuiChatBridgeCore();
        core.inputBuffer = 'existing text';
        core.cursorPosition = 'existing text'.length;

        handleInput(core, 'v', makeKey({ ctrl: true }));

        expect(core.inputBuffer).toBe('existing text');
        expect(core.cursorPosition).toBe('existing text'.length);
    });

    it('does not enqueue an event or write an error when no image is present', () => {
        vi.spyOn(clipboardImageControls, 'readClipboardImage').mockReturnValue(undefined);
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'v', makeKey({ ctrl: true }));

        expect(nextEvent(core)).toBeUndefined();
        expect(core.outputText).toBe('');
    });

    it('still appends v to the input buffer when ctrl is not held', () => {
        const core = createOpenTuiChatBridgeCore();

        handleInput(core, 'v', makeKey());

        expect(core.inputBuffer).toBe('v');
        expect(core.cursorPosition).toBe(1);
    });

    it('returns undefined when clipboard tools are not installed (no crash)', () => {
        // execSync is mocked at module level to throw (simulating missing
        // xclip/wl-paste/pngpaste). The real readClipboardImage must
        // swallow that and return undefined.
        const result = clipboardImageControls.readClipboardImage();

        expect(result).toBeUndefined();
    });
});
