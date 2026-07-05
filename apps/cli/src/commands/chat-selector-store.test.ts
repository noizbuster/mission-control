/**
 * Store-contract tests for `createChatSelectorStore` — the pure, React-free
 * core that backs ChatInputArea's selector subscription.
 *
 * These tests exercise the `useSyncExternalStore` contract directly: React
 * re-renders iff (a) `onStoreChange` is called AND (b) the next
 * `getSnapshot()` is not equal to the previous. We assert both halves against
 * a real `ChatStore`, plus the referential-stability invariant that prevents
 * the `useSyncExternalStore` infinite-loop ("snapshot changed during render").
 *
 * Three assertions mirror `use-keymap-selector.test.ts:33-93`:
 *   1. re-render-on-change — mutate a selected slice -> listener fires + value differs.
 *   2. no-re-render-on-unrelated — mutate outputText via emitOutput -> listener silent.
 *   3. referential-stability — repeated getSnapshot with no mutation -> same reference.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { createChatSelectorStore } from './chat-selector-store.js';
import { type ChatStore, createChatStore } from './chat-store.js';

describe('createChatSelectorStore', () => {
    let store: ChatStore;

    afterEach(() => {
        vi.useRealTimers();
    });

    it('notifies the listener and changes the snapshot when a selected slice mutates', () => {
        store = createChatStore();
        const selectorStore = createChatSelectorStore(store, (snap) => ({
            generating: snap.generating,
            inputMirror: snap.inputMirror,
        }));

        const listener = vi.fn();
        const dispose = selectorStore.subscribe(listener);

        const before = selectorStore.getSnapshot();
        expect(before.generating).toBe(false);

        // Mutate a selected slice synchronously (setGenerating calls publish() directly).
        store.setGenerating(true);

        const after = selectorStore.getSnapshot();

        expect(listener).toHaveBeenCalledTimes(1);
        expect(after.generating).toBe(true);
        expect(after).not.toBe(before);

        dispose();
    });

    it('does NOT notify the listener when an unselected slice (outputText) mutates', () => {
        vi.useFakeTimers();
        store = createChatStore();
        const selectorStore = createChatSelectorStore(store, (snap) => ({
            generating: snap.generating,
            inputMirror: snap.inputMirror,
        }));

        const listener = vi.fn();
        const dispose = selectorStore.subscribe(listener);

        expect(selectorStore.getSnapshot().generating).toBe(false);

        // Mutate outputText via emitOutput — coalesced behind a 16ms timer.
        store.emitOutput('token-1\n');
        store.emitOutput('token-2\n');
        vi.advanceTimersByTime(50);

        // The parent store DID publish and outputText DID change.
        expect(store.getSnapshot().outputText).toBe('token-1\ntoken-2\n');
        // But the selector filtered it out: generating/inputMirror are unchanged.
        expect(listener).not.toHaveBeenCalled();

        dispose();
    });

    it('returns a referentially stable snapshot across repeated getSnapshot calls without mutation', () => {
        store = createChatStore();
        const selectorStore = createChatSelectorStore(store, (snap) => ({
            generating: snap.generating,
            inputMirror: snap.inputMirror,
            overlayMode: snap.overlayMode,
        }));

        const first = selectorStore.getSnapshot();
        const second = selectorStore.getSnapshot();
        const third = selectorStore.getSnapshot();

        expect(second).toBe(first);
        expect(third).toBe(first);
    });
});
