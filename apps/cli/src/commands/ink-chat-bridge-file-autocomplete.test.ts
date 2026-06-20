import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';
import { createInkChatBridgeCore, handleInput, type InkChatBridgeCore } from './ink-chat-bridge.js';

const repoRoot = process.cwd();

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

function typeText(core: InkChatBridgeCore, text: string): void {
    for (const char of text) {
        handleInput(core, char, makeKey());
    }
}

describe('ink chat bridge @path file autocomplete', () => {
    it('opens the popup when the user types @ followed by path chars', () => {
        const core = createInkChatBridgeCore();
        typeText(core, '@pac');
        expect(core.fileAutocomplete.open).toBe(true);
        expect(core.fileAutocomplete.prefix).toBe('pac');
        expect(core.fileAutocomplete.matches.some((m) => m.name === 'packages')).toBe(true);
    });

    it('closes the popup when the input does not contain an active @ suffix', () => {
        const core = createInkChatBridgeCore();
        typeText(core, '@pac');
        expect(core.fileAutocomplete.open).toBe(true);
        // typing a space terminates the @ prefix
        handleInput(core, ' ', makeKey());
        expect(core.fileAutocomplete.open).toBe(false);
    });

    it('does not open the popup for slash commands', () => {
        const core = createInkChatBridgeCore();
        typeText(core, '/model @pac');
        // slash command wins; @ never activates
        expect(core.fileAutocomplete.open).toBe(false);
    });

    it('completes the path on Tab and keeps the @ hint in the buffer', () => {
        const core = createInkChatBridgeCore();
        typeText(core, '@pack');
        // select "packages" (directories sort first; it should be at or near index 0)
        const packagesIndex = core.fileAutocomplete.matches.findIndex((m) => m.name === 'packages');
        expect(packagesIndex).toBeGreaterThanOrEqual(0);
        for (let i = 0; i < packagesIndex; i += 1) {
            handleInput(core, '', makeKey({ downArrow: true }));
        }
        handleInput(core, '', makeKey({ tab: true }));
        expect(core.inputBuffer).toBe('@packages/');
        expect(core.cursorPosition).toBe(core.inputBuffer.length);
        // popup stays open for the new (now-empty-filter) directory listing
        expect(core.fileAutocomplete.open).toBe(true);
        expect(core.fileAutocomplete.prefix).toBe('packages/');
        // nothing was submitted
        expect(nextEvent(core)).toBeUndefined();
    });

    it('completes a nested path: @packages/co -> @packages/core/ on Enter without submitting', () => {
        const core = createInkChatBridgeCore();
        typeText(core, '@packages/co');
        const coreIndex = core.fileAutocomplete.matches.findIndex((m) => m.name === 'core');
        expect(coreIndex).toBeGreaterThanOrEqual(0);
        for (let i = 0; i < coreIndex; i += 1) {
            handleInput(core, '', makeKey({ downArrow: true }));
        }
        handleInput(core, '\r', makeKey({ return: true }));
        expect(core.inputBuffer).toBe('@packages/core/');
        expect(nextEvent(core)).toBeUndefined();
    });

    it('submits the buffer with the @ hint intact when the popup has no matches', () => {
        const core = createInkChatBridgeCore();
        typeText(core, '@zzzzzz-no-such-entry');
        expect(core.fileAutocomplete.open).toBe(true);
        expect(core.fileAutocomplete.matches).toEqual([]);
        handleInput(core, '\r', makeKey({ return: true }));
        expect(nextEvent(core)).toEqual({ type: 'line', value: '@zzzzzz-no-such-entry' });
        expect(core.inputBuffer).toBe('');
    });

    it('closes the popup on Escape without clearing the typed text', () => {
        const core = createInkChatBridgeCore();
        typeText(core, '@pac');
        expect(core.fileAutocomplete.open).toBe(true);
        handleInput(core, '', makeKey({ escape: true }));
        expect(core.fileAutocomplete.open).toBe(false);
        expect(core.inputBuffer).toBe('@pac');
    });

    it('navigates the selection with Up/Down and wraps around', () => {
        const core = createInkChatBridgeCore();
        typeText(core, '@');
        const total = core.fileAutocomplete.matches.length;
        expect(total).toBeGreaterThan(1);
        const startIndex = core.fileAutocomplete.selectedIndex;
        handleInput(core, '', makeKey({ downArrow: true }));
        expect(core.fileAutocomplete.selectedIndex).toBe((startIndex + 1) % total);
        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.fileAutocomplete.selectedIndex).toBe(startIndex);
    });

    it('excludes denied directories from the root listing', () => {
        const core = createInkChatBridgeCore();
        typeText(core, '@');
        const names = core.fileAutocomplete.matches.map((m) => m.name);
        expect(names).not.toContain('node_modules');
        expect(names).not.toContain('.git');
        expect(names).toContain('packages');
    });

    it('backspace after @ shrinks the prefix and refreshes matches', () => {
        const core = createInkChatBridgeCore();
        typeText(core, '@package');
        expect(core.fileAutocomplete.matches.some((m) => m.name === 'packages')).toBe(true);
        handleInput(core, '', makeKey({ backspace: true }));
        expect(core.fileAutocomplete.prefix).toBe('packag');
        expect(core.fileAutocomplete.open).toBe(true);
    });

    it('honors an explicit workspaceRoot override', () => {
        const core = createInkChatBridgeCore({ workspaceRoot: repoRoot });
        typeText(core, '@pack');
        expect(core.fileAutocomplete.matches.some((m) => m.name === 'packages')).toBe(true);
    });
});
