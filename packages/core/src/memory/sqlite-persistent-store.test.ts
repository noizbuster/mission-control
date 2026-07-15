import { afterEach, describe, expect, it } from 'vitest';
import type { MemoryEntry, MemoryQuery } from './persistent-memory-store';
import {
    deserializeValue,
    entryMatchesQuery,
    isExpired,
    isSqliteAvailable,
    SqlitePersistentStore,
    serializeValue,
} from './sqlite-persistent-store';

const entry = (overrides: Partial<MemoryEntry> = {}): MemoryEntry => ({
    key: 'k',
    namespace: 'goals',
    value: 'v',
    createdAt: '2026-06-16T00:00:00.000Z',
    expiresAt: undefined,
    ...overrides,
});

const sqliteAvailable = await isSqliteAvailable();

describe('sqlite-persistent-store — pure helpers (binding-free)', () => {
    it('serializeValue round-trips JSON and envelopes non-serialisable values', () => {
        expect(deserializeValue(serializeValue({ a: 1 }))).toEqual({ a: 1 });
        const circular: { self?: unknown } = {};
        circular.self = circular;
        const blob = serializeValue(circular);
        expect(blob).toContain('__nonSerialisable');
        expect(deserializeValue(blob)).toHaveProperty('__nonSerialisable', true);
    });

    it('deserializeValue returns undefined for malformed blobs', () => {
        expect(deserializeValue('not json{')).toBeUndefined();
    });

    it('isExpired respects expiresAt and treats undefined as never-expiring', () => {
        expect(isExpired({ expiresAt: undefined }, Date.now())).toBe(false);
        expect(isExpired({ expiresAt: '2020-01-01T00:00:00.000Z' }, Date.now())).toBe(true);
        expect(isExpired({ expiresAt: '2099-01-01T00:00:00.000Z' }, Date.now())).toBe(false);
    });

    it('entryMatchesQuery filters by namespace + substring over key and value', () => {
        const e = entry({ key: 'auth-token', value: { secret: 'hunter2' } });
        const q = (query: MemoryQuery) => entryMatchesQuery(e, query);
        expect(q({ namespace: 'goals' })).toBe(true);
        expect(q({ namespace: 'observations' })).toBe(false);
        expect(q({ text: 'auth' })).toBe(true);
        expect(q({ text: 'hunter2' })).toBe(true);
        expect(q({ text: 'nope' })).toBe(false);
    });
});

describe('sqlite-persistent-store — DB round-trip (when binding present)', () => {
    let store: SqlitePersistentStore | undefined;

    afterEach(() => {
        store?.close();
        store = undefined;
    });

    it.skipIf(!sqliteAvailable)(
        'CRUD + list + query + TTL prune (requires optional better-sqlite3 binding)',
        async () => {
            store = await SqlitePersistentStore.open(':memory:');

            await store.set('alpha', 'goals', { n: 1 });
            await store.set('beta', 'goals', 'second', 10); // expires in 10ms
            await store.set('gamma', 'observations', 'third');

            expect(await store.get('alpha', 'goals')).toEqual({ n: 1 });
            expect(await store.get('missing', 'goals')).toBeUndefined();

            const goals = await store.list('goals');
            expect(goals.map((e) => e.key).sort()).toEqual(['alpha', 'beta']);

            const hits = await store.query({ namespace: 'goals', text: 'second' });
            expect(hits).toHaveLength(1);
            expect(hits[0]?.key).toBe('beta');

            // Overwrite updates in place.
            await store.set('alpha', 'goals', { n: 2 });
            expect(await store.get('alpha', 'goals')).toEqual({ n: 2 });

            // TTL: beta expires after 10ms. Wait, then prune.
            await new Promise((resolve) => setTimeout(resolve, 30));
            // A get() lazily deletes the expired entry.
            expect(await store.get('beta', 'goals')).toBeUndefined();
            // prune() also removes expired rows and reports the count.
            await store.set('delta', 'goals', 'd', 1);
            await new Promise((resolve) => setTimeout(resolve, 20));
            const removed = await store.prune(new Date().toISOString());
            expect(removed).toBeGreaterThanOrEqual(1);
        },
    );

    it('isSqliteAvailable reports the binding status', async () => {
        // Sanity: the probe returns a boolean and does not throw.
        const result = await isSqliteAvailable();
        expect(typeof result).toBe('boolean');
    });
});
