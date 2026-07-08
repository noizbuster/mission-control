/**
 * React reactive-selector bridge for `@opentui/keymap` (T1 foundation).
 *
 * `@opentui/keymap/react` ships `useKeymap`/`useBindings`/`useActiveKeys`/
 * `usePendingSequence` but NO `useKeymapSelector` (that is `/solid`-only). A
 * command palette (T8) and which-key panel (T9) need to derive an arbitrary
 * view of the command/binding graph and re-render when it changes, so this
 * module provides the React equivalent of Solid's `useKeymapSelector`.
 *
 * The bridge is built ONLY on React `useSyncExternalStore` + the keymap's
 * batched `keymap.on("state", fn)` change signal (verified at
 * `@opentui/keymap/src/keymap.d.ts:24`; there is no `onCommandGraphChange`).
 * It never imports `solid-js` or `@opentui/keymap/solid`.
 *
 * Two exports:
 *   - `createKeymapSelectorStore` — the pure, React-free store bindings
 *     (`subscribe` + `getSnapshot`) with a version-keyed snapshot cache. This is
 *     the unit-testable core; the hook is a thin wrapper over it.
 *   - `useKeymapSelectorReact` — the hook, which reads the keymap from
 *     `@opentui/keymap/react`'s context and feeds the store to
 *     `useSyncExternalStore`.
 *
 * Snapshot-stability strategy (CRITICAL):
 *   `useSyncExternalStore` requires `getSnapshot()` to return a value that is
 *   `Object.is`-equal across calls while the store has not signalled a change;
 *   otherwise React detects "snapshot changed during render" and re-renders
 *   forever. Keymap read APIs (`getCommandEntries`, `getCommandBindings`, ...)
 *   allocate a fresh container on every call, so the store memoizes the
 *   selector result keyed on a monotonically increasing state version that
 *   bumps on every batched `on("state")` signal. The cache also tracks the
 *   selector reference, so swapping a memoized selector re-derives.
 *   Callers MUST pass a referentially stable selector (module-level or wrapped
 *   in `useCallback`); an inline arrow returning a fresh object would bust the
 *   cache every render. Primitives (numbers/booleans/strings) are always safe.
 */

import { useKeymap } from '@opentui/keymap/react';
import { useRef, useSyncExternalStore } from 'react';
import type { OpenTuiKeymap } from './keymap-instance.js';

/**
 * Minimal structural shape the store depends on: any object exposing the
 * batched state-change subscription. `OpenTuiKeymap` and the testing fake both
 * satisfy it, so the store is unit-testable without a native renderer.
 */
export interface KeymapStateSubscribable {
    on(name: 'state', fn: () => void): () => void;
}

/** The `useSyncExternalStore` store contract. */
export interface KeymapSelectorStore<T> {
    readonly subscribe: (onStoreChange: () => void) => () => void;
    readonly getSnapshot: () => T;
}

interface CachedSnapshot<T, TSelector> {
    readonly version: number;
    readonly selector: TSelector;
    readonly value: T;
}

/**
 * Build a `useSyncExternalStore`-compatible store that derives `selector` from
 * `keymap` and re-derives only when the keymap emits a batched `state` signal
 * (layer/command/binding graph change) or when the `selector` identity changes.
 *
 * The returned `subscribe`/`getSnapshot` close over a shared version counter
 * and a single-entry cache, guaranteeing referential stability of the snapshot
 * between state changes.
 */
export function createKeymapSelectorStore<TKeymap extends KeymapStateSubscribable, T>(
    keymap: TKeymap,
    selector: (km: TKeymap) => T,
): KeymapSelectorStore<T> {
    let version = 0;
    let cache: CachedSnapshot<T, typeof selector> | null = null;

    const subscribe = (onStoreChange: () => void): (() => void) => {
        const dispose = keymap.on('state', () => {
            version += 1;
            onStoreChange();
        });
        return () => {
            dispose();
        };
    };

    const getSnapshot = (): T => {
        if (cache !== null && cache.version === version && cache.selector === selector) {
            return cache.value;
        }
        const value = selector(keymap);
        cache = { version, selector, value };
        return value;
    };

    return { subscribe, getSnapshot };
}

/**
 * Reactively derive any view from the chat keymap. Re-runs `selector` whenever
 * the keymap command/binding graph changes (the batched `state` signal).
 *
 * `selector` MUST be referentially stable (module-level or `useCallback`); see
 * the module header for the snapshot-stability rationale.
 */
export function useKeymapSelectorReact<T>(selector: (km: OpenTuiKeymap) => T): T {
    const keymap = useKeymap();
    // Lazily build the store once for the lifetime of this keymap. A ref (not
    // useMemo) is used so the store — and its captured selector — survive every
    // re-render without risk of React discarding it; the keymap is stable for
    // the chat session. The store is rebuilt only if the component first mounts
    // under a different keymap (a different provider).
    const storeRef = useRef<KeymapSelectorStore<T> | null>(null);
    if (storeRef.current === null) {
        storeRef.current = createKeymapSelectorStore(keymap, selector);
    }
    const store = storeRef.current;
    // getSnapshot is the server snapshot too: the TUI never SSRs, and reusing the
    // same stable function avoids an extra closure.
    return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
