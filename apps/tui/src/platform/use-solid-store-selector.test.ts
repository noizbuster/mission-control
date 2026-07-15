import type { Accessor } from 'solid-js';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSolidStoreSelector } from './use-solid-store-selector';

type SolidLifecycle = {
    cleanups: (() => void)[];
};

const lifecycle = vi.hoisted((): SolidLifecycle => ({ cleanups: [] }));

vi.mock('solid-js', async (importOriginal) => {
    const solid = await importOriginal<typeof import('solid-js')>();
    return {
        ...solid,
        onMount: (callback: () => void): void => {
            callback();
        },
        onCleanup: (callback: () => void): void => {
            lifecycle.cleanups.push(callback);
        },
    };
});

type CounterSnapshot = {
    readonly count: number;
    readonly label: string;
};

class CounterStore {
    private snapshot: CounterSnapshot = { count: 1, label: 'initial' };
    private readonly listeners = new Set<() => void>();

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    getSnapshot(): CounterSnapshot {
        return this.snapshot;
    }

    publish(snapshot: CounterSnapshot): void {
        this.snapshot = snapshot;
        for (const listener of this.listeners) {
            listener();
        }
    }

    listenerCount(): number {
        return this.listeners.size;
    }
}

describe('useSolidStoreSelector', () => {
    beforeEach(() => {
        lifecycle.cleanups = [];
    });

    it('returns an accessor that updates when the external store publishes', () => {
        // Given: a framework-free external store and a Solid selector accessor.
        const store = new CounterStore();
        const selected: Accessor<number> = useSolidStoreSelector(store, (snapshot) => snapshot.count);

        // When: the store publishes a new snapshot.
        store.publish({ count: 2, label: 'updated' });

        // Then: the returned Solid accessor reflects the selected value.
        expect(selected()).toBe(2);
        expect(store.listenerCount()).toBe(1);
    });

    it('disposes the external-store subscription with the Solid owner', () => {
        // Given: a mounted selector hook.
        const store = new CounterStore();
        useSolidStoreSelector(store, (snapshot) => snapshot.count);
        expect(store.listenerCount()).toBe(1);

        // When: the Solid owner cleanup runs.
        for (const cleanup of lifecycle.cleanups.splice(0)) {
            cleanup();
        }

        // Then: the hook releases the external-store listener.
        expect(store.listenerCount()).toBe(0);
    });
});
