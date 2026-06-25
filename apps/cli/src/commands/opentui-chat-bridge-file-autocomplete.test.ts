/**
 * Test seam: `@path` file autocomplete spans the exported `bridgeContentChange`
 * (mirrors typed text + refreshes the autocomplete state), `bridgeTextareaKeyDown`
 * (Tab completes synchronously via `applyFileAutocompleteCompletion` → textarea
 * `setText`; Up/Down navigate; Escape closes; Enter completes via the deferred
 * `bridgeSubmit`). Typing is simulated by seeding the recording textarea's
 * `plainText` (the source of truth) and mirroring it through
 * `bridgeContentChange`. Assertions target `core.fileAutocomplete` and the
 * textarea's recorded `setText` calls — NOT `core.inputBuffer` as the editing
 * source of truth (the textarea owns it).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    bridgeContentChange,
    bridgeTextareaKeyDown,
    createOpenTuiChatBridgeCore,
} from './opentui-chat-bridge.js';
import {
    asScrollboxRef,
    asTextareaRef,
    createRecordingScrollbox,
    createRecordingTextarea,
    makeKeyEvent,
} from './opentui-chat-bridge-test-support.js';

const repoRoot = process.cwd();

function setup(typed: string, workspaceRoot: string = repoRoot) {
    const core = createOpenTuiChatBridgeCore({ workspaceRoot });
    const textarea = createRecordingTextarea(typed);
    const textareaRef = asTextareaRef(textarea);
    const scrollboxRef = asScrollboxRef(createRecordingScrollbox());
    bridgeContentChange(core, typed);
    return { core, textarea, textareaRef, scrollboxRef };
}

describe('opentui bridge @path file autocomplete', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });
    afterEach(() => {
        vi.useRealTimers();
    });

    it('opens the popup when the user types @ followed by path chars', () => {
        const { core } = setup('@pac');

        expect(core.fileAutocomplete.open).toBe(true);
        expect(core.fileAutocomplete.prefix).toBe('pac');
        expect(core.fileAutocomplete.matches.some((m) => m.name === 'packages')).toBe(true);
    });

    it('closes the popup when the input does not contain an active @ suffix', () => {
        const { core, textarea } = setup('@pac');
        expect(core.fileAutocomplete.open).toBe(true);

        // Typing a space terminates the @ prefix — mirror the new buffer.
        textarea.setText('@pac ');
        bridgeContentChange(core, '@pac ');

        expect(core.fileAutocomplete.open).toBe(false);
        // setText here was the test simulating typing, not the bridge; clear it.
        expect(textarea.setTextCalls).toEqual(['@pac ']);
    });

    it('does not open the popup for slash commands', () => {
        const { core } = setup('/model @pac');

        expect(core.fileAutocomplete.open).toBe(false);
    });

    it('completes the path on Tab by rewriting the textarea via setText (not buffer-end)', () => {
        const { core, textarea, textareaRef, scrollboxRef } = setup('@pack');
        const packagesIndex = core.fileAutocomplete.matches.findIndex((m) => m.name === 'packages');
        expect(packagesIndex).toBeGreaterThanOrEqual(0);
        for (let i = 0; i < packagesIndex; i += 1) {
            bridgeTextareaKeyDown(core, makeKeyEvent('down'), textareaRef, scrollboxRef);
        }

        bridgeTextareaKeyDown(core, makeKeyEvent('tab'), textareaRef, scrollboxRef);

        expect(textarea.setTextCalls).toEqual(['@packages/']);
        expect(textarea.gotoBufferEndCount).toBe(1);
        // Popup stays open for the new (now-empty-filter) directory listing.
        expect(core.fileAutocomplete.open).toBe(true);
        expect(core.fileAutocomplete.prefix).toBe('packages/');
        expect(core.eventQueue.shift()).toBeUndefined();
    });

    it('completes a nested path: @packages/co -> @packages/core/ on Enter without submitting', () => {
        const { core, textarea, textareaRef, scrollboxRef } = setup('@packages/co');
        const coreIndex = core.fileAutocomplete.matches.findIndex((m) => m.name === 'core');
        expect(coreIndex).toBeGreaterThanOrEqual(0);
        for (let i = 0; i < coreIndex; i += 1) {
            bridgeTextareaKeyDown(core, makeKeyEvent('down'), textareaRef, scrollboxRef);
        }

        bridgeTextareaKeyDown(core, makeKeyEvent('return'), textareaRef, scrollboxRef);
        vi.runAllTimers();

        expect(textarea.setTextCalls).toEqual(['@packages/core/']);
        expect(core.eventQueue.shift()).toBeUndefined();
    });

    it('submits the buffer with the @ hint intact when the popup has no matches', () => {
        const { core, textareaRef, scrollboxRef } = setup('@zzzzzz-no-such-entry');
        expect(core.fileAutocomplete.open).toBe(true);
        expect(core.fileAutocomplete.matches).toEqual([]);

        bridgeTextareaKeyDown(core, makeKeyEvent('return'), textareaRef, scrollboxRef);
        vi.runAllTimers();

        expect(core.eventQueue.shift()).toEqual({ type: 'line', value: '@zzzzzz-no-such-entry' });
    });

    it('closes the popup on Escape without clearing the typed text', () => {
        const { core, textarea, textareaRef, scrollboxRef } = setup('@pac');
        expect(core.fileAutocomplete.open).toBe(true);

        bridgeTextareaKeyDown(core, makeKeyEvent('escape'), textareaRef, scrollboxRef);

        expect(core.fileAutocomplete.open).toBe(false);
        // Escape with an open autocomplete returns before the clear-buffer branch.
        expect(textarea.clearCount).toBe(0);
        expect(textarea.plainText).toBe('@pac');
    });

    it('navigates the selection with Up/Down and wraps around', () => {
        const { core, textareaRef, scrollboxRef } = setup('@');
        const total = core.fileAutocomplete.matches.length;
        expect(total).toBeGreaterThan(1);
        const startIndex = core.fileAutocomplete.selectedIndex;

        bridgeTextareaKeyDown(core, makeKeyEvent('down'), textareaRef, scrollboxRef);
        expect(core.fileAutocomplete.selectedIndex).toBe((startIndex + 1) % total);

        bridgeTextareaKeyDown(core, makeKeyEvent('up'), textareaRef, scrollboxRef);
        expect(core.fileAutocomplete.selectedIndex).toBe(startIndex);
    });

    it('excludes denied directories from the root listing', () => {
        const { core } = setup('@');
        const names = core.fileAutocomplete.matches.map((m) => m.name);

        expect(names).not.toContain('node_modules');
        expect(names).not.toContain('.git');
        expect(names).toContain('packages');
    });

    it('backspace after @ shrinks the prefix and refreshes matches', () => {
        const { core, textarea } = setup('@package');
        expect(core.fileAutocomplete.matches.some((m) => m.name === 'packages')).toBe(true);

        // Backspace shrinks the textarea buffer by one char (native); mirror it.
        textarea.setText('@packag');
        bridgeContentChange(core, '@packag');

        expect(core.fileAutocomplete.prefix).toBe('packag');
        expect(core.fileAutocomplete.open).toBe(true);
    });

    it('honors an explicit workspaceRoot override', () => {
        const { core } = setup('@pack', repoRoot);

        expect(core.fileAutocomplete.matches.some((m) => m.name === 'packages')).toBe(true);
    });
});
