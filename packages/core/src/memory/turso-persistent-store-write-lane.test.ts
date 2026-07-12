import { afterEach, describe, expect, it } from 'vitest';
import { type LocalLibsqlDb, openLocalLibsqlDb, runWithLocalLibsqlWriteLock } from '../db/local-libsql-db.js';
import { deferred } from '../db/local-libsql-registry-test-support.js';
import { TursoPersistentStore } from './turso-persistent-store.js';

const runtimes: LocalLibsqlDb[] = [];

afterEach(() => {
    for (const runtime of runtimes.splice(0)) runtime.close();
});

describe('TursoPersistentStore write lane', () => {
    it('keeps set pending while the runtime write lane is held', async () => {
        // Given
        const { runtime, store } = await createStore();
        const heldLane = holdWriteLane(runtime);
        await heldLane.started;

        // When
        const setting = store.set('queued', 'goals', 'value');

        // Then
        await expectPending(setting);
        heldLane.release();
        await expect(Promise.all([heldLane.done, setting])).resolves.toEqual([undefined, undefined]);
        await expect(store.get('queued', 'goals')).resolves.toBe('value');
    });

    it('keeps expired-row cleanup pending while the runtime write lane is held', async () => {
        // Given
        const { runtime, store } = await createStore();
        await store.set('expired', 'goals', 'value', 0);
        const heldLane = holdWriteLane(runtime);
        await heldLane.started;

        // When
        const getting = store.get('expired', 'goals');

        // Then
        await expectPending(getting);
        heldLane.release();
        await expect(Promise.all([heldLane.done, getting])).resolves.toEqual([undefined, undefined]);
    });

    it('keeps prune pending while the runtime write lane is held', async () => {
        // Given
        const { runtime, store } = await createStore();
        await store.set('expired', 'goals', 'value', 0);
        const heldLane = holdWriteLane(runtime);
        await heldLane.started;

        // When
        const pruning = store.prune(new Date().toISOString());

        // Then
        await expectPending(pruning);
        heldLane.release();
        await heldLane.done;
        await expect(pruning).resolves.toBe(1);
    });

    it('allows SELECT-only reads while the runtime write lane is held', async () => {
        // Given
        const { runtime, store } = await createStore();
        await store.set('readable', 'goals', 'value');
        const heldLane = holdWriteLane(runtime);
        await heldLane.started;

        // When
        const listing = store.list('goals');

        // Then
        await expect(listing).resolves.toMatchObject([{ key: 'readable', value: 'value' }]);
        heldLane.release();
        await heldLane.done;
    });

    it('does not delete a row refreshed after the expired value was read', async () => {
        // Given
        const { runtime, store } = await createStore();
        await store.set('refreshed', 'goals', 'expired', 0);
        const heldLane = holdWriteLane(runtime);
        await heldLane.started;
        const gettingExpired = store.get('refreshed', 'goals');
        await expectPending(gettingExpired);
        await runtime.client.execute({
            sql: 'UPDATE memory_entries SET value = ?, expires_at = NULL WHERE namespace = ? AND key = ?',
            args: [JSON.stringify('fresh'), 'goals', 'refreshed'],
        });

        // When
        heldLane.release();
        await Promise.all([heldLane.done, gettingExpired]);

        // Then
        await expect(store.get('refreshed', 'goals')).resolves.toBe('fresh');
    });
});

async function createStore(): Promise<{ readonly runtime: LocalLibsqlDb; readonly store: TursoPersistentStore }> {
    const runtime = await openLocalLibsqlDb({ url: ':memory:' });
    runtimes.push(runtime);
    return { runtime, store: TursoPersistentStore.fromRuntime(runtime) };
}

function holdWriteLane(target: LocalLibsqlDb): {
    readonly started: Promise<void>;
    readonly release: () => void;
    readonly done: Promise<void>;
} {
    const started = deferred();
    const release = deferred();
    const done = runWithLocalLibsqlWriteLock(target, async () => {
        started.resolve();
        await release.promise;
    });
    return { started: started.promise, release: release.resolve, done };
}

async function expectPending(operation: Promise<unknown>): Promise<void> {
    let settled = false;
    void operation.then(
        () => {
            settled = true;
        },
        () => {
            settled = true;
        },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
}
