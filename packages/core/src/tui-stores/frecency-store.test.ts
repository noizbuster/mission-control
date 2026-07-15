import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { frecencyScore, TuiFrecencyStore } from './frecency-store';
import {
    cleanupTuiStoreTestScope,
    createTuiStoreTestScope,
    expectNoMctrlWrites,
    expectNoTemporaryFiles,
    type TuiStoreTestScope,
} from './tui-store-test-support';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

describe('TuiFrecencyStore', () => {
    let scope: TuiStoreTestScope | undefined;
    let currentTime = 100;

    beforeEach(async () => {
        currentTime = 100;
        scope = await createTuiStoreTestScope('mctrl-tui-frecency');
    });

    afterEach(async () => {
        await cleanupTuiStoreTestScope(scope);
        scope = undefined;
    });

    it('records access counts atomically under MCTRL_DATA_DIR', async () => {
        // Given
        const store = createStore();

        // When
        await store.recordAccess('file-a.ts');
        currentTime = 110;
        const record = await store.recordAccess('file-a.ts');

        // Then
        expect(record).toMatchObject({ key: 'file-a.ts', accessCount: 2, firstSeenAt: 100, lastAccessedAt: 110 });
        await expectNoTemporaryFiles(store.filePath);
        await expectNoMctrlWrites(requireScope(scope), store.filePath);
    });

    it('truncates records to the configured bound by recent access', async () => {
        // Given
        const store = createStore(2);

        // When
        await store.recordAccess('one');
        currentTime = 110;
        await store.recordAccess('two');
        currentTime = 120;
        await store.recordAccess('three');

        // Then
        expect((await store.listRecords()).map((record) => record.key)).toEqual(['three', 'two']);
    });

    it('skips malformed JSONL lines and preserves valid frecency records', async () => {
        // Given
        const store = createStore();
        await mkdir(dirname(store.filePath), { recursive: true });
        await writeFile(
            store.filePath,
            `${JSON.stringify({ key: 'one', accessCount: 1, firstSeenAt: 1, lastAccessedAt: 1 })}\nnot-json\n${JSON.stringify({ key: 'bad', accessCount: 0, firstSeenAt: 1, lastAccessedAt: 1 })}\n${JSON.stringify({ key: 'two', accessCount: 2, firstSeenAt: 1, lastAccessedAt: 2 })}\n`,
            'utf8',
        );

        // When / Then
        expect((await store.listRecords()).map((record) => record.key)).toEqual(['two', 'one']);
    });

    it('orders scores by access count divided by age', async () => {
        // Given
        const store = createStore();
        await store.replaceRecords([
            { key: 'frequent-old', accessCount: 10, firstSeenAt: 1, lastAccessedAt: 100 },
            { key: 'recent', accessCount: 2, firstSeenAt: 1, lastAccessedAt: 190 },
        ]);

        // When
        const scored = await store.listByScore(200);

        // Then
        expect(scored.map((entry) => entry.record.key)).toEqual(['recent', 'frequent-old']);
        expect(frecencyScore({ key: 'recent', accessCount: 2, firstSeenAt: 1, lastAccessedAt: 190 }, 200)).toBe(0.2);
    });

    function createStore(maxEntries = 10): TuiFrecencyStore {
        return new TuiFrecencyStore({ maxEntries, now: () => currentTime });
    }
});

function requireScope(scope: TuiStoreTestScope | undefined): TuiStoreTestScope {
    if (scope !== undefined) {
        return scope;
    }
    throw new Error('test scope missing');
}
