import { describe, expect, it } from 'vitest';
import { InMemoryPersistentStore } from './persistent-memory-store.js';

describe('InMemoryPersistentStore (Phase 8 working-memory contract)', () => {
    it('round-trips a value under a namespace', async () => {
        const store = new InMemoryPersistentStore();
        await store.set('goal-1', 'goals', { text: 'ship feature X' });
        expect(await store.get('goal-1', 'goals')).toEqual({ text: 'ship feature X' });
    });

    it('lists entries by namespace', async () => {
        const store = new InMemoryPersistentStore();
        await store.set('a', 'observations', 'saw a bug');
        await store.set('b', 'observations', 'fixed it');
        await store.set('g', 'goals', 'done');
        const obs = await store.list('observations');
        expect(obs.map((entry) => entry.key).sort()).toEqual(['a', 'b']);
    });

    it('queries by namespace + substring (key or value)', async () => {
        const store = new InMemoryPersistentStore();
        await store.set('auth-bug', 'observations', 'login fails at line 42');
        await store.set('perf', 'observations', 'slow query');
        const hits = await store.query({ namespace: 'observations', text: 'bug' });
        expect(hits.map((entry) => entry.key)).toEqual(['auth-bug']);
    });

    it('prunes expired entries and respects TTL', async () => {
        const store = new InMemoryPersistentStore();
        await store.set('ephemeral', 'observations', 'temp', 10); // 10ms TTL
        await store.set('permanent', 'goals', 'forever');
        // Before expiry both present.
        expect(await store.get('ephemeral', 'observations')).toBe('temp');
        const removed = await store.prune(new Date(Date.now() + 1000).toISOString());
        expect(removed).toBe(1);
        expect(await store.get('ephemeral', 'observations')).toBeUndefined();
        expect(await store.get('permanent', 'goals')).toBe('forever');
    });

    it('limits query results with k', async () => {
        const store = new InMemoryPersistentStore();
        for (let index = 0; index < 5; index += 1) {
            await store.set(`o-${index}`, 'observations', `entry ${index}`);
        }
        expect((await store.query({ namespace: 'observations', k: 2 })).length).toBe(2);
    });
});
