import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalDbConfigError, LocalDbInitializationError, openLocalLibsqlDb } from '../db/local-libsql-db';
import type { PersistentMemoryStore } from './persistent-memory-store';
import { createPersistentStore } from './persistent-store-factory';
import { TursoPersistentStore } from './turso-persistent-store';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
        expect(existsSync(join(dataDir, 'mission-control.db'))).toBe(true);
        expect(existsSync(join(dataDir, 'memory.db'))).toBe(false);
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

    it('passes the data directory once to the central persistent-store opener', async () => {
        // Given an availability probe that succeeds and an opener that captures the data directory
        const openedDataDirs: string[] = [];
        const openStore = async (dataDir: string): Promise<PersistentMemoryStore> => {
            openedDataDirs.push(dataDir);
            return stubStore;
        };
        const dataDir = mkdtempSync(join(tmpdir(), 'mctrl-data-'));
        tmpDirs.push(dataDir);
        // When resolving the persistent store
        await createPersistentStore(dataDir, { probeAvailability: async () => true, openStore });
        // Then the opener received the data directory exactly once
        expect(openedDataDirs).toEqual([dataDir]);
    });

    it('falls back silently when the availability probe throws', async () => {
        // Given a probe that throws
        const dataDir = mkdtempSync(join(tmpdir(), 'mctrl-turso-open-failure-'));
        tmpDirs.push(dataDir);
        const store = await createPersistentStore(dataDir, {
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
        const dataDir = mkdtempSync(join(tmpdir(), 'mctrl-turso-open-failure-'));
        tmpDirs.push(dataDir);
        const store = await createPersistentStore(dataDir, {
            probeAvailability: async () => true,
            openStore: async () => {
                throw new Error('open failed');
            },
        });
        // Then the factory swallows the failure and returns undefined
        expect(store).toBeUndefined();
    });

    it.each([
        new LocalDbConfigError('remote_url', 'libsql://remote.example.com/app'),
        new LocalDbInitializationError('wal_refused', 'journal_mode', 'wal', 'delete'),
    ])('propagates typed local database failures unchanged', async (typedError) => {
        // Given
        const dataDir = mkdtempSync(join(tmpdir(), 'mctrl-turso-typed-failure-'));
        tmpDirs.push(dataDir);

        // When
        const opening = createPersistentStore(dataDir, {
            probeAvailability: async () => true,
            openStore: async () => Promise.reject(typedError),
        });

        // Then
        await expect(opening).rejects.toBe(typedError);
    });

    it('releases a supplied database lease when a runtime-backed store closes', async () => {
        // Given
        const runtime = await openLocalLibsqlDb({ url: ':memory:' });
        const closeLease = vi.spyOn(runtime, 'close');
        const store = TursoPersistentStore.fromRuntime(runtime);

        // When
        store.close();

        // Then
        expect(closeLease).toHaveBeenCalledOnce();
    });
});
