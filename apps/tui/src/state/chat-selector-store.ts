/**
 * Selector store wrapping `ChatStore` for fine-grained external-store
 * subscriptions. Mirrors the accessor-returning `useSolidStoreSelector`
 * subscription pattern with one enhancement: on parent notify, the selector is
 * re-derived and compared. Own listeners fire only when the selected value
 * actually changed, so a component selecting `generating` does NOT re-render
 * when `outputText` gains a token.
 *
 * Snapshot-stability strategy (CRITICAL):
 *   `ChatStore.getSnapshot()` returns a NEW object on every `publish()` (the
 *   `buildSnapshot()` spread at `chat-store.ts:1522-1528`). A pass-through
 *   `getSnapshot` would make external-store subscribers re-render on every token.
 *   The selector store caches the derived value keyed on a monotonically
 *   increasing version that bumps only when the selected slice changed,
 *   guaranteeing referential stability between unrelated parent publishes.
 *
 * Equality contract:
 *   The notify decision uses `Object.is` for primitives and a shallow
 *   `Object.is`-per-field walk for plain object results. This is the
 *   generalization the ChatInputArea selector needs: it returns
 *   `{ generating, inputMirror, ... }` and must not signal a change when the
 *   parent published but none of those fields actually differed. Callers
 *   selecting a single primitive get pure `Object.is`; callers selecting an
 *   object get the same semantics applied field-by-field.
 */

import type { ChatStore, ChatStoreState } from './chat-store';

/** The external-store subscription contract. */
export interface ChatSelectorStore<T> {
    readonly subscribe: (onStoreChange: () => void) => () => void;
    readonly getSnapshot: () => T;
}

interface CachedSelection<T, TSelector> {
    readonly version: number;
    readonly selector: TSelector;
    readonly value: T;
}

/**
 * `Object.is` for primitives; shallow `Object.is`-per-field for plain objects.
 * Arrays and non-plain objects fall back to reference identity (Object.is),
 * matching how ChatInputArea's selector is structured (plain object of
 * primitive + stable-reference fields).
 */
function selectionChanged(prev: unknown, next: unknown): boolean {
    if (Object.is(prev, next)) return false;
    if (prev === null || next === null || typeof prev !== 'object' || typeof next !== 'object') {
        return true;
    }
    const prevRecord = prev as Record<string, unknown>;
    const nextRecord = next as Record<string, unknown>;
    const prevKeys = Object.keys(prevRecord);
    const nextKeys = Object.keys(nextRecord);
    if (prevKeys.length !== nextKeys.length) return true;
    for (const key of prevKeys) {
        if (!Object.is(prevRecord[key], nextRecord[key])) return true;
    }
    return false;
}

/**
 * Build an external-store-compatible selector that derives `selector`
 * from `store` and re-derives only when the parent store publishes. Own
 * listeners are notified only when the selected value changes (`Object.is` for
 * primitives, shallow for plain objects), guaranteeing that a component
 * selecting a narrow slice does not re-render on unrelated parent publishes.
 *
 * Callers MUST pass a referentially stable selector (module-level or wrapped
 * in a framework-level memo); an inline arrow that changes identity every render would
 * bust the single-entry cache on every derivation. The ChatInputArea selector
 * is module-level for this reason.
 */
export function createChatSelectorStore<T>(
    store: ChatStore,
    selector: (snapshot: ChatStoreState) => T,
): ChatSelectorStore<T> {
    let version = 0;
    let cache: CachedSelection<T, typeof selector> | null = null;

    const subscribe = (onStoreChange: () => void): (() => void) => {
        return store.subscribe(() => {
            const next = selector(store.getSnapshot());
            if (cache !== null && !selectionChanged(cache.value, next)) {
                // Selected slice unchanged — suppress the notification so
                // subscribers do not even schedule a re-render.
                return;
            }
            version += 1;
            cache = { version, selector, value: next };
            onStoreChange();
        });
    };

    const getSnapshot = (): T => {
        if (cache !== null && cache.version === version && cache.selector === selector) {
            return cache.value;
        }
        const value = selector(store.getSnapshot());
        cache = { version, selector, value };
        return value;
    };

    return { subscribe, getSnapshot };
}
