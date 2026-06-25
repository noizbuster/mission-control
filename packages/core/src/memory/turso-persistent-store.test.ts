import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isTursoAvailable, TursoPersistentStore } from './turso-persistent-store.js';

describe('TursoPersistentStore', () => {
    let store: TursoPersistentStore;

    beforeEach(async () => {
        store = await TursoPersistentStore.open(':memory:');
    });

    afterEach(() => {
        store.close();
    });

    it('round-trips a value through set + get', async () => {
        // Given an empty store
        // When setting then getting by key + namespace
        await store.set('key1', 'goals', { target: 'ship it' });
        const result = await store.get('key1', 'goals');
        // Then the same value comes back
        expect(result).toEqual({ target: 'ship it' });
    });

    it('returns undefined for a missing key', async () => {
        const result = await store.get('missing', 'goals');
        expect(result).toBeUndefined();
    });

    it('returns undefined for a missing namespace', async () => {
        await store.set('key1', 'goals', 'v1');
        const result = await store.get('key1', 'observations');
        expect(result).toBeUndefined();
    });

    it('overwrites an existing key+namespace via upsert', async () => {
        // Given an existing entry
        await store.set('key1', 'goals', { target: 'original' });
        // When setting the same composite key with a new value
        await store.set('key1', 'goals', { target: 'updated' });
        const result = await store.get('key1', 'goals');
        // Then the updated value is returned, not the original
        expect(result).toEqual({ target: 'updated' });
    });

    it('keeps keys with the same name isolated by namespace', async () => {
        // Given the same key under two namespaces
        await store.set('shared', 'goals', 'goal-value');
        await store.set('shared', 'observations', 'obs-value');
        // When reading each namespace
        // Then each namespace returns its own value
        expect(await store.get('shared', 'goals')).toBe('goal-value');
        expect(await store.get('shared', 'observations')).toBe('obs-value');
    });

    it('lists entries scoped to one namespace', async () => {
        // Given two entries in one namespace and one in another
        await store.set('key1', 'goals', { target: 'a' });
        await store.set('key2', 'goals', { target: 'b' });
        await store.set('key1', 'observations', 'other');
        // When listing the goals namespace
        const entries = await store.list('goals');
        // Then only goals entries are returned
        expect(entries).toHaveLength(2);
        expect(entries.map((entry) => entry.key).sort()).toEqual(['key1', 'key2']);
    });

    it('populates MemoryEntry fields on list', async () => {
        await store.set('key1', 'goals', { target: 'a' });
        const [entry] = await store.list('goals');
        expect(entry).toBeDefined();
        expect(entry?.key).toBe('key1');
        expect(entry?.namespace).toBe('goals');
        expect(entry?.value).toEqual({ target: 'a' });
        expect(entry?.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
        expect(entry?.expiresAt).toBeUndefined();
    });

    it('queries by substring against the serialized value', async () => {
        // Given entries with distinguishable text in the value
        await store.set('key1', 'goals', { target: 'ship it' });
        await store.set('key2', 'goals', { target: 'test it' });
        // When querying for "ship"
        const matched = await store.query({ text: 'ship' });
        // Then only the matching entry is returned
        expect(matched).toHaveLength(1);
        expect(matched[0]?.key).toBe('key1');
    });

    it('queries by substring against the key', async () => {
        await store.set('alpha-key', 'goals', 'v1');
        await store.set('beta-key', 'goals', 'v2');
        const matched = await store.query({ text: 'alpha' });
        expect(matched).toHaveLength(1);
        expect(matched[0]?.key).toBe('alpha-key');
    });

    it('queries by namespace filter', async () => {
        await store.set('key1', 'goals', 'v1');
        await store.set('key1', 'observations', 'v2');
        const matched = await store.query({ namespace: 'goals' });
        expect(matched).toHaveLength(1);
        expect(matched[0]?.namespace).toBe('goals');
    });

    it('honors query.k as a limit', async () => {
        await store.set('key1', 'goals', 'v1');
        await store.set('key2', 'goals', 'v2');
        await store.set('key3', 'goals', 'v3');
        const matched = await store.query({ namespace: 'goals', k: 2 });
        expect(matched).toHaveLength(2);
    });

    it('treats an immediately-expired entry as missing on get', async () => {
        // Given an entry whose TTL is 0 (expires at the set instant)
        await store.set('temp', 'goals', 'tempvalue', 0);
        // When getting it after expiry
        const expired = await store.get('temp', 'goals');
        // Then it is treated as missing
        expect(expired).toBeUndefined();
    });

    it('lazy-deletes an expired entry on get', async () => {
        // Given an expired entry that has been read once (triggering lazy delete)
        await store.set('temp', 'goals', 'tempvalue', 0);
        await store.get('temp', 'goals');
        // When listing the namespace
        const entries = await store.list('goals');
        // Then the expired entry is gone
        expect(entries).toHaveLength(0);
    });

    it('excludes expired entries from list', async () => {
        await store.set('fresh', 'goals', 'v1');
        await store.set('stale', 'goals', 'v2', 0);
        const entries = await store.list('goals');
        expect(entries).toHaveLength(1);
        expect(entries[0]?.key).toBe('fresh');
    });

    it('excludes expired entries from query', async () => {
        await store.set('fresh', 'goals', 'matchable', 1000);
        await store.set('stale', 'goals', 'matchable', 0);
        const matched = await store.query({ text: 'matchable' });
        expect(matched).toHaveLength(1);
        expect(matched[0]?.key).toBe('fresh');
    });

    it('prunes expired entries and returns the count removed', async () => {
        // Given two expired entries and one fresh entry (none read via get, so no lazy delete yet)
        await store.set('stale1', 'goals', 'v1', 0);
        await store.set('stale2', 'goals', 'v2', 0);
        await store.set('fresh', 'goals', 'v3');
        // When pruning as of now
        const pruned = await store.prune(new Date().toISOString());
        // Then exactly the two expired entries are removed and the count is returned
        expect(pruned).toBe(2);
        const remaining = await store.list('goals');
        expect(remaining).toHaveLength(1);
        expect(remaining[0]?.key).toBe('fresh');
    });

    it('prunes nothing when no entries are expired', async () => {
        await store.set('fresh1', 'goals', 'v1');
        await store.set('fresh2', 'goals', 'v2');
        const pruned = await store.prune(new Date().toISOString());
        expect(pruned).toBe(0);
        expect(await store.list('goals')).toHaveLength(2);
    });

    it('prunes entries whose expiresAt is in the past relative to the passed timestamp', async () => {
        // Given an entry expiring in the future
        await store.set('temp', 'goals', 'v1', 60_000);
        // When pruning with a timestamp beyond its expiry
        const future = new Date(Date.now() + 120_000).toISOString();
        const pruned = await store.prune(future);
        // Then it is removed
        expect(pruned).toBe(1);
    });

    it('isTursoAvailable resolves true for an embedded :memory: probe', async () => {
        const available = await isTursoAvailable();
        expect(available).toBe(true);
    });
});
