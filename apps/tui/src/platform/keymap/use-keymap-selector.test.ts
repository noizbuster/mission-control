/**
 * T1 failing-first proof for the React keymap reactive bridge.
 *
 * These tests exercise the `createKeymapSelectorStore` contract — the pure,
 * React-free core that backs `useKeymapSelectorReact`. The store is what
 * `useSyncExternalStore` actually consumes, so verifying its `subscribe` +
 * `getSnapshot` contract against a REAL keymap is the faithful equivalent of a
 * render test: React re-renders iff (a) `onStoreChange` is called AND (b) the
 * next `getSnapshot()` is not `Object.is`-equal to the previous. We assert both
 * halves directly, plus the referential-stability invariant that prevents the
 * `useSyncExternalStore` infinite-loop ("snapshot changed during render").
 *
 * Why no rendered component: apps/cli has no `react-dom`, no
 * `react-test-renderer`, and no DOM test environment (jsdom/happy-dom), and the
 * plan forbids adding dependencies. `useSyncExternalStore` only works inside a
 * React render, and there is no host renderer available to drive one. The store
 * contract below is exactly what React relies on, driven against a real
 * `@opentui/keymap/testing` keymap (pure JS — no native FFI backend).
 */

import { createTestKeymap } from '@opentui/keymap/testing';
import { describe, expect, it } from 'vitest';
import { createKeymapSelectorStore } from './use-keymap-selector.js';

/** Register a real command on the keymap; returns the unregister function. */
function registerProbeCommand(
    keymap: { registerLayer: (l: { commands: readonly { name: string; run: () => boolean }[] }) => () => void },
    name: string,
): () => void {
    return keymap.registerLayer({ commands: [{ name, run: () => true }] });
}

describe('createKeymapSelectorStore', () => {
    it('re-derives the selector value when the keymap command graph changes (misleading-success guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        const keymap = harness.keymap;

        // Selector over the command/binding graph: the number of reachable
        // command entries. This is the kind of view a command palette or
        // which-key panel would derive via useKeymapSelectorReact.
        const store = createKeymapSelectorStore(keymap, (km) => km.getCommandEntries().length);

        let onChangeCount = 0;
        const dispose = store.subscribe(() => {
            onChangeCount += 1;
        });

        const before = store.getSnapshot();

        // Real structural mutation: registering a command with a handler fires
        // the batched `keymap.on("state")` signal synchronously (verified
        // empirically). This is the indirect fire the task requires.
        const offCommand = registerProbeCommand(keymap, 't1.probe.command');

        const after = store.getSnapshot();

        // The misleading-success probe: a test that only checks "subscribe was
        // called" is a false positive. We assert the snapshot VALUE actually
        // changed, which is what causes a real React re-render.
        expect(onChangeCount).toBeGreaterThan(0);
        expect(after).not.toBe(before);
        expect(after).toBe(before + 1);

        offCommand();
        dispose();
        harness.cleanup();
    });

    it('returns a referentially stable snapshot when the graph is unchanged (stale-state / infinite-loop guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        const keymap = harness.keymap;

        // Object/array selector: getCommandEntries allocates a fresh array on
        // every call, which is precisely the shape that triggers the
        // useSyncExternalStore infinite-loop if getSnapshot is not memoized.
        const store = createKeymapSelectorStore(keymap, (km) => km.getCommandEntries());

        // First, prove the cache is load-bearing: the raw keymap read returns a
        // NEW reference each call (so a naive getSnapshot would loop forever).
        expect(keymap.getCommandEntries()).not.toBe(keymap.getCommandEntries());

        const first = store.getSnapshot();
        const second = store.getSnapshot();
        const third = store.getSnapshot();

        // The store MUST hand back the exact same reference until a `state`
        // signal arrives — otherwise useSyncExternalStore detects "snapshot
        // changed during render" and re-renders forever.
        expect(second).toBe(first);
        expect(third).toBe(first);

        harness.cleanup();
    });

    it('keeps the snapshot stable across a second subscriber add/remove and then re-derives on a real state change (flaky-subscriber guard)', () => {
        const harness = createTestKeymap({ defaultKeys: true });
        const keymap = harness.keymap;
        const store = createKeymapSelectorStore(keymap, (km) => km.getCommandEntries());

        // Consumer 1 subscribes.
        const disposeOne = store.subscribe(() => {});

        const stableBefore = store.getSnapshot();

        // A second consumer subscribes and then unsubscribes. useSyncExternalStore
        // calls subscribe once per consumer; adding/removing must not perturb the
        // snapshot reference for the surviving consumer.
        const disposeTwo = store.subscribe(() => {});
        const duringTwo = store.getSnapshot();
        expect(duringTwo).toBe(stableBefore);

        disposeTwo();
        const afterTwoRemoved = store.getSnapshot();
        expect(afterTwoRemoved).toBe(stableBefore);

        // After a genuine state change, the cache is invalidated and the next
        // snapshot is a fresh reference (the consumer would re-render exactly once).
        const offCommand = registerProbeCommand(keymap, 't1.flaky.command');
        const afterMutation = store.getSnapshot();
        expect(afterMutation).not.toBe(stableBefore);
        expect(afterMutation.length).toBe(stableBefore.length + 1);

        offCommand();
        disposeOne();
        harness.cleanup();
    });
});
