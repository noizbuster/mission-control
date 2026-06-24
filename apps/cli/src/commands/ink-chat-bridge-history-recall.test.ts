import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';
import { createInkChatBridgeCore, handleInput, type InkChatBridgeCore } from './ink-chat-bridge.js';
import { createChatInputHistoryFromEntries } from './interactive-chat-input-history.js';

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

describe('ink chat bridge prompt history recall', () => {
    it('walks back one entry per Up press through plain prompts', () => {
        const core = createInkChatBridgeCore();
        core.history = createChatInputHistoryFromEntries(['oldest', 'middle', 'newest']);

        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.inputBuffer).toBe('newest');

        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.inputBuffer).toBe('middle');

        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.inputBuffer).toBe('oldest');

        // Bounded at the oldest entry — a further Up is a no-op.
        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.inputBuffer).toBe('oldest');
    });

    it('continues walking history after recalling a `/`-prefixed entry', () => {
        // Regression: recalling a `/` entry left inputBuffer starting with `/`,
        // so the next Up was captured by the slash-command menu instead of history.
        const core = createInkChatBridgeCore();
        core.history = createChatInputHistoryFromEntries(['plain older', '/model claude']);

        // Recall the newest entry, which starts with `/`.
        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.inputBuffer).toBe('/model claude');

        // Second Up must keep walking history to the older entry, not get stuck on
        // the slash menu just because inputBuffer now starts with `/`.
        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.inputBuffer).toBe('plain older');
    });

    it('continues walking history after recalling a `#`-prefixed entry', () => {
        const core = createInkChatBridgeCore();
        core.history = createChatInputHistoryFromEntries(['plain older', '#planner {ship it}']);

        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.inputBuffer).toBe('#planner {ship it}');

        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.inputBuffer).toBe('plain older');
    });

    it('walks forward on Down and clears to the draft at the bottom', () => {
        const core = createInkChatBridgeCore();
        core.history = createChatInputHistoryFromEntries(['old', 'recent']);

        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.inputBuffer).toBe('recent');
        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.inputBuffer).toBe('old');

        handleInput(core, '', makeKey({ downArrow: true }));
        expect(core.inputBuffer).toBe('recent');

        // Back to the draft slot (entered from empty input) -> empty.
        handleInput(core, '', makeKey({ downArrow: true }));
        expect(core.inputBuffer).toBe('');
    });

    it('still routes Up to the slash-command menu when typing `/` at the draft slot', () => {
        // Guard against an over-broad change: the prefix menu must keep winning
        // while the user is NOT yet navigating history.
        const core = createInkChatBridgeCore();
        core.history = createChatInputHistoryFromEntries(['never recalled']);

        handleInput(core, '/', makeKey());
        handleInput(core, '', makeKey({ upArrow: true }));

        // History cursor stays at the draft slot; input is untouched by history.
        expect(core.history.cursor).toBe(core.history.entries.length);
        expect(core.inputBuffer).toBe('/');
    });

    it('restores a captured draft when navigating back down to the bottom', () => {
        const core = createInkChatBridgeCore();
        core.history = createChatInputHistoryFromEntries(['old', 'recent']);

        // Type an in-progress draft, then recall history from it.
        handleInput(core, 'half-typed draft', makeKey());
        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.inputBuffer).toBe('recent');
        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.inputBuffer).toBe('old');

        // Walking back down to the draft slot restores the captured draft.
        handleInput(core, '', makeKey({ downArrow: true }));
        expect(core.inputBuffer).toBe('recent');
        handleInput(core, '', makeKey({ downArrow: true }));
        expect(core.inputBuffer).toBe('half-typed draft');
    });

    it('exposes the current navigation position through the snapshot', () => {
        const core = createInkChatBridgeCore();
        core.history = createChatInputHistoryFromEntries(['a', 'b']);

        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.snapshot.historyNavigation).toEqual({ position: 2, total: 2 });

        handleInput(core, '', makeKey({ upArrow: true }));
        expect(core.snapshot.historyNavigation).toEqual({ position: 1, total: 2 });

        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '', makeKey({ downArrow: true }));
        expect(core.snapshot.historyNavigation).toBeNull();
    });
});
