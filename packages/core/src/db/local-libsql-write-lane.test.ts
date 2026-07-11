import { describe, expect, expectTypeOf, it } from 'vitest';
import {
    LocalDbWriteError,
    type LocalLibsqlWriteTarget,
    openLocalLibsqlDb,
    runWithLocalLibsqlWriteLock,
} from './local-libsql-db.js';
import { deferred } from './local-libsql-registry-test-support.js';

class TestWriteError extends Error {
    readonly name = 'TestWriteError';
}

describe('local libSQL write lane', () => {
    it('accepts only a local libSQL write target', () => {
        // Given: the low-level write admission function is inspected at compile time.
        const firstParameter = expectTypeOf(runWithLocalLibsqlWriteLock).parameter(0);

        // When: its admitted target type is compared with the runtime write target.
        // Then: no raw key, URL, or internal lane handle is part of the signature.
        firstParameter.toEqualTypeOf<LocalLibsqlWriteTarget>();
    });

    it('admits three sibling writes in FIFO order', async () => {
        // Given: three sibling writes each hold their turn until explicitly released.
        const runtime = await openLocalLibsqlDb({ url: ':memory:' });
        const firstStarted = deferred();
        const secondStarted = deferred();
        const thirdStarted = deferred();
        const firstRelease = deferred();
        const secondRelease = deferred();
        const thirdRelease = deferred();
        const starts: string[] = [];

        // When: all three writes are submitted before the first releases.
        const first = runWithLocalLibsqlWriteLock(runtime, async () => {
            starts.push('A');
            firstStarted.resolve();
            await firstRelease.promise;
            return 'A';
        });
        const second = runWithLocalLibsqlWriteLock(runtime, async () => {
            starts.push('B');
            secondStarted.resolve();
            await secondRelease.promise;
            return 'B';
        });
        const third = runWithLocalLibsqlWriteLock(runtime, async () => {
            starts.push('C');
            thirdStarted.resolve();
            await thirdRelease.promise;
            return 'C';
        });

        // Then: only the head starts, and each release admits exactly the next sibling.
        await firstStarted.promise;
        expect(starts).toEqual(['A']);
        firstRelease.resolve();
        await secondStarted.promise;
        expect(starts).toEqual(['A', 'B']);
        secondRelease.resolve();
        await thirdStarted.promise;
        expect(starts).toEqual(['A', 'B', 'C']);
        thirdRelease.resolve();
        await expect(Promise.all([first, second, third])).resolves.toEqual(['A', 'B', 'C']);
        runtime.close();
    });

    it('admits the next sibling after a writer rejects', async () => {
        // Given: a rejecting writer holds the lane ahead of a healthy sibling.
        const runtime = await openLocalLibsqlDb({ url: ':memory:' });
        const firstStarted = deferred();
        const firstRelease = deferred();
        const failure = new TestWriteError('write failed');
        let secondStarted = false;
        const first = runWithLocalLibsqlWriteLock(runtime, async () => {
            firstStarted.resolve();
            await firstRelease.promise;
            throw failure;
        });
        const second = runWithLocalLibsqlWriteLock(runtime, async () => {
            secondStarted = true;
            return 'healthy';
        });

        // When: the first writer rejects.
        await firstStarted.promise;
        expect(secondStarted).toBe(false);
        firstRelease.resolve();

        // Then: its original error escapes and the queued sibling still runs.
        await expect(first).rejects.toBe(failure);
        await expect(second).resolves.toBe('healthy');
        expect(secondStarted).toBe(true);
        runtime.close();
    });

    it('rejects same-target nesting within the current tick and keeps the lane healthy', async () => {
        // Given: one runtime already holds its write lane.
        const runtime = await openLocalLibsqlDb({ url: ':memory:' });
        let nestedSettled = false;

        // When: the held async context attempts to acquire the same runtime again.
        await runWithLocalLibsqlWriteLock(runtime, async () => {
            const nested = runWithLocalLibsqlWriteLock(runtime, async () => 'nested');
            void nested.then(
                () => {
                    nestedSettled = true;
                },
                () => {
                    nestedSettled = true;
                },
            );
            await Promise.resolve();

            // Then: reentry rejects before it can queue behind itself.
            expect(nestedSettled).toBe(true);
            await expect(nested).rejects.toBeInstanceOf(LocalDbWriteError);
            await expect(nested).rejects.toMatchObject({ code: 'write_lane_reentrant' });
        });
        await expect(runWithLocalLibsqlWriteLock(runtime, async () => 'healthy')).resolves.toBe('healthy');
        runtime.close();
    });

    it('uses the client-bound runtime identity when a target supplies a mismatched key', async () => {
        // Given: a forged structural target reuses a held runtime client with another key.
        const runtime = await openLocalLibsqlDb({ url: ':memory:' });
        const mismatched = { client: runtime.client, writeKey: Symbol('mismatched') } satisfies LocalLibsqlWriteTarget;
        let nestedSettled = false;

        // When: the mismatched target attempts to nest through the held client.
        await runWithLocalLibsqlWriteLock(runtime, async () => {
            const nested = runWithLocalLibsqlWriteLock(mismatched, async () => 'nested');
            void nested.then(
                () => {
                    nestedSettled = true;
                },
                () => {
                    nestedSettled = true;
                },
            );
            await Promise.resolve();

            // Then: the bound runtime identity still rejects reentry immediately.
            expect(nestedSettled).toBe(true);
            await expect(nested).rejects.toMatchObject({ code: 'write_lane_reentrant' });
        });
        runtime.close();
    });

    it('clears held identity state inherited by detached work after the writer releases', async () => {
        // Given: detached work inherits the writer's async context but waits beyond its release.
        const runtime = await openLocalLibsqlDb({ url: ':memory:' });
        const startDetached = deferred();
        let detached = Promise.resolve('not-started');
        await runWithLocalLibsqlWriteLock(runtime, async () => {
            detached = startDetached.promise.then(() => runWithLocalLibsqlWriteLock(runtime, async () => 'detached'));
        });

        // When: the inherited work acquires the runtime after the original write completed.
        startDetached.resolve();

        // Then: stale async context does not produce a false reentry rejection.
        await expect(detached).resolves.toBe('detached');
        runtime.close();
    });

    it('allows a held runtime to nest a write for a different target', async () => {
        // Given: two independent in-memory runtimes have distinct write identities.
        const first = await openLocalLibsqlDb({ url: ':memory:' });
        const second = await openLocalLibsqlDb({ url: ':memory:' });

        // When: the first runtime writes through the second runtime inside its held context.
        const result = await runWithLocalLibsqlWriteLock(first, () =>
            runWithLocalLibsqlWriteLock(second, async () => 'distinct-target'),
        );

        // Then: the distinct target is admitted normally.
        expect(result).toBe('distinct-target');
        first.close();
        second.close();
    });

    it('runs independent memory runtime writes concurrently', async () => {
        // Given: one in-memory runtime holds its write lane.
        const first = await openLocalLibsqlDb({ url: ':memory:' });
        const second = await openLocalLibsqlDb({ url: ':memory:' });
        const firstStarted = deferred();
        const firstRelease = deferred();
        const secondStarted = deferred();
        const holding = runWithLocalLibsqlWriteLock(first, async () => {
            firstStarted.resolve();
            await firstRelease.promise;
        });
        await firstStarted.promise;

        // When: the other runtime starts a write before the first releases.
        const independent = runWithLocalLibsqlWriteLock(second, async () => {
            secondStarted.resolve();
            return 'concurrent';
        });

        // Then: the second lane runs without waiting for the first.
        await secondStarted.promise;
        await expect(independent).resolves.toBe('concurrent');
        firstRelease.resolve();
        await holding;
        first.close();
        second.close();
    });
});
