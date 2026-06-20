import type { Key } from 'ink';
import { describe, expect, it, vi } from 'vitest';
import { createAbgOverlayController } from './abg-overlay-controller.js';
import { createAbgOverlayStore } from './abg-overlay-state.js';
import { createInkChatBridgeCore, handleInput, type InkChatBridgeCore } from './ink-chat-bridge.js';

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

function openOverlay(core: InkChatBridgeCore): void {
    handleInput(core, 'g', makeKey({ ctrl: true }));
}

function closeOverlayViaCtrlG(core: InkChatBridgeCore): void {
    handleInput(core, 'g', makeKey({ ctrl: true }));
}

function attachController(core: InkChatBridgeCore): ReturnType<typeof createAbgOverlayController> {
    const controller = createAbgOverlayController(createAbgOverlayStore());
    core.abgOverlayController = controller;
    return controller;
}

describe('ink chat bridge ABG overlay toggle', () => {
    it('opens the overlay on Ctrl+G from idle chat and closes on a second Ctrl+G', () => {
        const core = createInkChatBridgeCore();

        openOverlay(core);
        expect(core.abgOverlayActive).toBe(true);
        expect(core.snapshot.abgOverlayActive).toBe(true);

        closeOverlayViaCtrlG(core);
        expect(core.abgOverlayActive).toBe(false);
        expect(core.snapshot.abgOverlayActive).toBe(false);
    });

    it('opens on Ctrl+G then closes on Escape', () => {
        const core = createInkChatBridgeCore();

        openOverlay(core);
        expect(core.abgOverlayActive).toBe(true);

        handleInput(core, '', makeKey({ escape: true }));
        expect(core.abgOverlayActive).toBe(false);
    });

    it('blocks Ctrl+G while an approval overlay is active (Metis 2.5)', () => {
        const core = createInkChatBridgeCore();
        core.approvalActive = true;

        handleInput(core, 'g', makeKey({ ctrl: true }));

        expect(core.abgOverlayActive).toBe(false);
    });

    it('flushes the CJK composition buffer before toggling the overlay on (Metis 2.1)', () => {
        const core = createInkChatBridgeCore();
        core.cjkCompositionBuffer = '\u4F60\u597D';

        handleInput(core, 'g', makeKey({ ctrl: true }));

        expect(core.cjkCompositionBuffer).toBe('');
        expect(core.abgOverlayActive).toBe(true);
    });

    it('flushes the CJK composition buffer before toggling the overlay off', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);
        core.cjkCompositionBuffer = '\u4F60';

        handleInput(core, 'g', makeKey({ ctrl: true }));

        expect(core.cjkCompositionBuffer).toBe('');
        expect(core.abgOverlayActive).toBe(false);
    });
});

describe('ink chat bridge ABG overlay tab navigation', () => {
    it('selects a tab directly via digit keys (3 maps to index 2)', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);

        handleInput(core, '3', makeKey());

        expect(core.abgOverlayActiveTab).toBe(2);
    });

    it('resets scroll offset to 0 when a digit selects a tab', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);
        core.abgOverlayScrollOffset = 15;

        handleInput(core, '1', makeKey());

        expect(core.abgOverlayActiveTab).toBe(0);
        expect(core.abgOverlayScrollOffset).toBe(0);
    });

    it('cycles the active tab forward on Tab', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);
        handleInput(core, '3', makeKey());

        handleInput(core, '', makeKey({ tab: true }));

        expect(core.abgOverlayActiveTab).toBe(3);
    });

    it('cycles the active tab backward on Shift+Tab and wraps from 0 to the last tab', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);
        handleInput(core, '1', makeKey());
        expect(core.abgOverlayActiveTab).toBe(0);

        handleInput(core, '', makeKey({ tab: true, shift: true }));

        expect(core.abgOverlayActiveTab).toBe(6);
    });

    it('wraps forward from the last tab to the first on Tab', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);
        handleInput(core, '7', makeKey());
        expect(core.abgOverlayActiveTab).toBe(6);

        handleInput(core, '', makeKey({ tab: true }));

        expect(core.abgOverlayActiveTab).toBe(0);
    });
});

describe('ink chat bridge ABG overlay scroll', () => {
    it('increments scroll offset on Up arrow', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);

        handleInput(core, '', makeKey({ upArrow: true }));

        expect(core.abgOverlayScrollOffset).toBe(1);
    });

    it('decrements scroll offset on Down arrow without going below 0', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);
        core.abgOverlayScrollOffset = 5;

        handleInput(core, '', makeKey({ downArrow: true }));
        expect(core.abgOverlayScrollOffset).toBe(4);

        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '', makeKey({ downArrow: true }));
        handleInput(core, '', makeKey({ downArrow: true }));

        expect(core.abgOverlayScrollOffset).toBe(0);
    });

    it('jumps by SCROLL_PAGE_SIZE on PageUp/PageDown', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);

        handleInput(core, '', makeKey({ pageUp: true }));
        expect(core.abgOverlayScrollOffset).toBe(10);

        handleInput(core, '', makeKey({ pageDown: true }));
        expect(core.abgOverlayScrollOffset).toBe(0);
    });

    it('jumps to top on Home and bottom on End', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);

        handleInput(core, '', makeKey({ home: true }));
        expect(core.abgOverlayScrollOffset).toBe(Number.MAX_SAFE_INTEGER);

        handleInput(core, '', makeKey({ end: true }));
        expect(core.abgOverlayScrollOffset).toBe(0);
    });
});

describe('ink chat bridge ABG overlay input blocking', () => {
    it('does not enqueue a chat line while the overlay is active', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);

        handleInput(core, 'hello\r', makeKey({ return: true }));

        expect(core.eventQueue).toEqual([]);
        expect(core.inputBuffer).toBe('');
    });

    it('does not enqueue an interrupt event on Ctrl+C while the overlay is active', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);

        handleInput(core, 'c', makeKey({ ctrl: true }));

        expect(core.eventQueue).toEqual([]);
    });

    it('does not enqueue events when typing arbitrary text while the overlay is active', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);

        for (const ch of 'random text') {
            handleInput(core, ch, makeKey());
        }
        handleInput(core, '\r', makeKey({ return: true }));

        expect(core.eventQueue).toEqual([]);
    });
});

describe('ink chat bridge ABG overlay action keys', () => {
    it('toggles live-token display on the t key', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);
        expect(core.abgOverlayLiveOutput).toBe(false);

        handleInput(core, 't', makeKey());

        expect(core.abgOverlayLiveOutput).toBe(true);

        handleInput(core, 't', makeKey());

        expect(core.abgOverlayLiveOutput).toBe(false);
    });

    it('calls controller.flushNow on the r key', () => {
        const core = createInkChatBridgeCore();
        const controller = attachController(core);
        const spy = vi.spyOn(controller, 'flushNow');
        openOverlay(core);

        handleInput(core, 'r', makeKey());

        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('calls controller.clearTimeline on the c key', () => {
        const core = createInkChatBridgeCore();
        const controller = attachController(core);
        const spy = vi.spyOn(controller, 'clearTimeline');
        openOverlay(core);

        handleInput(core, 'c', makeKey());

        expect(spy).toHaveBeenCalledTimes(1);
    });

    it('does not treat Ctrl+R as the refresh key (ctrl modifier routes differently)', () => {
        const core = createInkChatBridgeCore();
        const controller = attachController(core);
        const spy = vi.spyOn(controller, 'flushNow');
        openOverlay(core);

        handleInput(core, 'r', makeKey({ ctrl: true }));

        expect(spy).not.toHaveBeenCalled();
    });
});

describe('ink chat bridge ABG overlay controller reset', () => {
    it('calls controller.reset and clears the store when the overlay closes via Ctrl+G', () => {
        const core = createInkChatBridgeCore();
        const controller = attachController(core);
        const resetSpy = vi.spyOn(controller, 'reset');
        openOverlay(core);

        handleInput(core, 'g', makeKey({ ctrl: true }));

        expect(resetSpy).toHaveBeenCalledTimes(1);
        expect(core.abgOverlayActive).toBe(false);
    });

    it('calls controller.reset when the overlay closes via Escape', () => {
        const core = createInkChatBridgeCore();
        const controller = attachController(core);
        const resetSpy = vi.spyOn(controller, 'reset');
        openOverlay(core);

        handleInput(core, '', makeKey({ escape: true }));

        expect(resetSpy).toHaveBeenCalledTimes(1);
        expect(core.abgOverlayActive).toBe(false);
    });

    it('reset() restores the store snapshot to defaults and sets active to false (Metis 5.3)', () => {
        const store = createAbgOverlayStore();
        const controller = createAbgOverlayController(store);

        store.setActive(true);
        store.update((draft) => {
            draft.inputTokens = 42;
            draft.outputTokens = 7;
            draft.recentEvents = [{ timestamp: '', type: 'test', message: 'hello' }];
        });

        controller.reset();

        const snapshot = store.getSnapshot();
        expect(store.isActive()).toBe(false);
        expect(snapshot.inputTokens).toBe(0);
        expect(snapshot.outputTokens).toBe(0);
        expect(snapshot.recentEvents).toEqual([]);
        expect(snapshot.runState).toBe('idle');
    });

    it('clearTimeline empties recentEvents in the store', () => {
        const store = createAbgOverlayStore();
        const controller = createAbgOverlayController(store);

        store.update((draft) => {
            draft.recentEvents = [
                { timestamp: '', type: 'a', message: 'one' },
                { timestamp: '', type: 'b', message: 'two' },
            ];
        });

        controller.clearTimeline();

        expect(store.getSnapshot().recentEvents).toEqual([]);
    });
});

describe('ink chat bridge ABG overlay direct digit selection (1-7)', () => {
    it.each([
        ['1', 0],
        ['2', 1],
        ['3', 2],
        ['4', 3],
        ['5', 4],
        ['6', 5],
        ['7', 6],
    ] as const)('selects tab index %i on digit %s and resets the scroll offset', (digit, expectedTab) => {
        const core = createInkChatBridgeCore();
        openOverlay(core);
        core.abgOverlayScrollOffset = 23;

        handleInput(core, digit, makeKey());

        expect(core.abgOverlayActiveTab).toBe(expectedTab);
        expect(core.abgOverlayScrollOffset).toBe(0);
        expect(core.snapshot.abgOverlayActiveTab).toBe(expectedTab);
    });

    it('silently ignores digits 8 and 9 (no tab bound) via the default branch', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);
        handleInput(core, '3', makeKey());
        expect(core.abgOverlayActiveTab).toBe(2);

        handleInput(core, '8', makeKey());
        handleInput(core, '9', makeKey());

        expect(core.abgOverlayActiveTab).toBe(2);
        expect(core.eventQueue).toEqual([]);
    });

    it('does not treat Ctrl+3 as a tab shortcut (ctrl modifier skips the digit switch)', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);

        handleInput(core, '3', makeKey({ ctrl: true }));

        expect(core.abgOverlayActiveTab).toBe(0);
        expect(core.eventQueue).toEqual([]);
    });

    it('does not treat Meta+3 as a tab shortcut (meta modifier skips the digit switch)', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);

        handleInput(core, '3', makeKey({ meta: true }));

        expect(core.abgOverlayActiveTab).toBe(0);
        expect(core.eventQueue).toEqual([]);
    });
});

describe('ink chat bridge ABG overlay close via raw escape byte', () => {
    it('closes on a raw \\u001b byte even when key.escape is false', () => {
        const core = createInkChatBridgeCore();
        const controller = attachController(core);
        const resetSpy = vi.spyOn(controller, 'reset');
        openOverlay(core);

        handleInput(core, '\u001b', makeKey());

        expect(core.abgOverlayActive).toBe(false);
        expect(core.snapshot.abgOverlayActive).toBe(false);
        expect(resetSpy).toHaveBeenCalledTimes(1);
    });

    it('does not enqueue a chat event when closing via the raw escape byte', () => {
        const core = createInkChatBridgeCore();
        openOverlay(core);

        handleInput(core, '\u001b', makeKey());

        expect(core.eventQueue).toEqual([]);
    });
});
