import type { Key } from 'ink';
import { describe, expect, it } from 'vitest';
import { createInkChatBridgeCore, handleInput } from './ink-chat-bridge.js';

const SCROLL_PAGE_SIZE = 10;

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

describe('ink chat bridge PgUp/PgDn/Home/End scrollback navigation', () => {
    it('starts with scrollOffset at 0', () => {
        const core = createInkChatBridgeCore();

        expect(core.scrollOffset).toBe(0);
    });

    it('increases scrollOffset by the page size on PgUp', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, '', makeKey({ pageUp: true }));

        expect(core.scrollOffset).toBe(SCROLL_PAGE_SIZE);
    });

    it('decreases scrollOffset by the page size on PgDn', () => {
        const core = createInkChatBridgeCore();
        handleInput(core, '', makeKey({ pageUp: true }));
        handleInput(core, '', makeKey({ pageUp: true }));

        handleInput(core, '', makeKey({ pageDown: true }));

        expect(core.scrollOffset).toBe(SCROLL_PAGE_SIZE);
    });

    it('clamps scrollOffset to 0 when PgDn is pressed at the bottom', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, '', makeKey({ pageDown: true }));

        expect(core.scrollOffset).toBe(0);
    });

    it('jumps to the top on Home by setting a large scrollOffset', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, '', makeKey({ home: true }));

        expect(core.scrollOffset).toBe(Number.MAX_SAFE_INTEGER);
    });

    it('jumps to the bottom on End by resetting scrollOffset to 0', () => {
        const core = createInkChatBridgeCore();
        handleInput(core, '', makeKey({ pageUp: true }));
        handleInput(core, '', makeKey({ pageUp: true }));

        handleInput(core, '', makeKey({ end: true }));

        expect(core.scrollOffset).toBe(0);
    });

    it('returns to 0 after multiple PgUp presses followed by End', () => {
        const core = createInkChatBridgeCore();
        handleInput(core, '', makeKey({ pageUp: true }));
        handleInput(core, '', makeKey({ pageUp: true }));
        handleInput(core, '', makeKey({ pageUp: true }));

        expect(core.scrollOffset).toBe(SCROLL_PAGE_SIZE * 3);

        handleInput(core, '', makeKey({ end: true }));

        expect(core.scrollOffset).toBe(0);
    });

    it('reflects scrollOffset changes in the published snapshot', () => {
        const core = createInkChatBridgeCore();

        handleInput(core, '', makeKey({ pageUp: true }));

        expect(core.snapshot.scrollOffset).toBe(SCROLL_PAGE_SIZE);

        handleInput(core, '', makeKey({ end: true }));

        expect(core.snapshot.scrollOffset).toBe(0);
    });
});
