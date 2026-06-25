import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { PersistentMemoryStore } from './persistent-memory-store.js';
import { createPersistentStore } from './persistent-store-factory.js';
import { TursoPersistentStore } from './turso-persistent-store.js';

const stubStore: PersistentMemoryStore = {
    get: async () => undefined,
    set: async () => undefined,
    list: async () => [],
    query: async () => [],
    prune: async () => 0,
};

const tmpDirs: string[] = [];

afterEach(() => {
    while (tmpDirs.length > 0) {
        const dir = tmpDirs.pop();
        if (dir !== undefined) {
            rmSync(dir, { recursive: true, force: true });
        }
    }
});

describe('createPersistentStore (runtime wiring)', () => {
    it('returns a working TursoPersistentStore when libSQL is available', async () => {
        // Given a fresh data dir and a real libSQL runtime
        const dataDir = mkdtempSync(join(tmpdir(), 'mctrl-turso-wiring-'));
        tmpDirs.push(dataDir);
        // When resolving the persistent store for that dir
        const store = await createPersistentStore(dataDir);
        // Then a live TursoPersistentStore is returned and round-trips a value
        if (!(store instanceof TursoPersistentStore)) {
            throw new Error('expected createPersistentStore to return a TursoPersistentStore');
        }
        await store.set('ship', 'goals', { target: 'done' });
        expect(await store.get('ship', 'goals')).toEqual({ target: 'done' });
        store.close();
    });

    it('returns undefined when libSQL is unavailable and never opens a store', async () => {
        // Given a probe that reports libSQL unavailable
        const openStore = async (): Promise<PersistentMemoryStore> => {
            throw new Error('openStore must not be called when libSQL is unavailable');
        };
        // When resolving the persistent store
        const store = await createPersistentStore('/ignored', {
            probeAvailability: async () => false,
            openStore,
        });
        // Then no store is returned (the runtime falls back to in-memory-only)
        expect(store).toBeUndefined();
    });

    it('resolves the database path to file:<dataDir>/memory.db', async () => {
        // Given an availability probe that succeeds and an opener that captures the URL
        let capturedUrl: string | undefined;
        const openStore = async (url: string): Promise<PersistentMemoryStore> => {
            capturedUrl = url;
            return stubStore;
        };
        const dataDir = join(tmpdir(), 'mctrl-data');
        // When resolving the persistent store
        await createPersistentStore(dataDir, { probeAvailability: async () => true, openStore });
        // Then the opener received the embedded file URL under the data dir
        expect(capturedUrl).toBe(`file:${join(dataDir, 'memory.db')}`);
    });

    it('falls back silently when the availability probe throws', async () => {
        // Given a probe that throws
        const store = await createPersistentStore('/ignored', {
            probeAvailability: async () => {
                throw new Error('probe failed');
            },
            openStore: async () => {
                throw new Error('openStore must not be called on probe failure');
            },
        });
        // Then the factory swallows the failure and returns undefined
        expect(store).toBeUndefined();
    });

    it('falls back silently when opening the store throws', async () => {
        // Given a successful probe but an opener that throws
        const store = await createPersistentStore('/ignored', {
            probeAvailability: async () => true,
            openStore: async () => {
                throw new Error('open failed');
            },
        });
        // Then the factory swallows the failure and returns undefined
        expect(store).toBeUndefined();
    });
});
