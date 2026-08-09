import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TuiPromptHistoryStore } from './prompt-history-store';
import {
    cleanupTuiStoreTestScope,
    createTuiStoreTestScope,
    expectNoMctrlWrites,
    expectNoTemporaryFiles,
    type TuiStoreTestScope,
} from './tui-store-test-support';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

describe('TuiPromptHistoryStore', () => {
    let scope: TuiStoreTestScope | undefined;
    let idCounter = 0;

    beforeEach(async () => {
        idCounter = 0;
        scope = await createTuiStoreTestScope('mctrl-tui-history');
    });

    afterEach(async () => {
        await cleanupTuiStoreTestScope(scope);
        scope = undefined;
    });

    it('appends typed prompt history to the legacy input-history data path', async () => {
        // Given
        const store = createStore();

        // When
        await store.appendText('first prompt');

        // Then
        expect(await store.listTexts()).toEqual(['first prompt']);
        expect(store.filePath.endsWith('/input-history.json')).toBe(true);
        await expectNoTemporaryFiles(store.filePath);
        await expectNoMctrlWrites(requireScope(scope), store.filePath);
    });

    it('truncates history entries to the configured bound', async () => {
        // Given
        const store = createStore(2);

        // When
        await store.appendText('one');
        await store.appendText('two');
        await store.appendText('three');

        // Then
        expect(await store.listTexts()).toEqual(['two', 'three']);
    });

    it('reads the existing CLI string-array input-history format', async () => {
        // Given
        const store = createStore();
        await mkdir(dirname(store.filePath), { recursive: true });
        await writeFile(store.filePath, JSON.stringify({ entries: ['old prompt', '', 'new prompt'] }), 'utf8');

        // When
        const entries = await store.listEntries();

        // Then
        expect(entries.map((entry) => entry.text)).toEqual(['old prompt', 'new prompt']);
        expect(entries.map((entry) => entry.timestamp)).toEqual([0, 0]);
    });

    it('returns an empty list for malformed JSON', async () => {
        // Given
        const store = createStore();
        await mkdir(dirname(store.filePath), { recursive: true });
        await writeFile(store.filePath, '{bad json', 'utf8');

        // When / Then
        await expect(store.listEntries()).resolves.toEqual([]);
    });

    function createStore(maxEntries = 10): TuiPromptHistoryStore {
        return new TuiPromptHistoryStore({
            maxEntries,
            now: () => 10,
            idFactory: () => {
                idCounter += 1;
                return `entry-${idCounter}`;
            },
        });
    }
});

function requireScope(scope: TuiStoreTestScope | undefined): TuiStoreTestScope {
    if (scope !== undefined) {
        return scope;
    }
    throw new Error('test scope missing');
}

describe('TuiPromptHistoryStore concurrency', () => {
    it('serializes concurrent appendText without dropping entries', async () => {
        const { mkdtemp } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const dir = await mkdtemp(join(tmpdir(), 'mctrl-history-'));
        let n = 0;
        const store = new TuiPromptHistoryStore({
            dataDir: dir,
            now: () => 1000,
            idFactory: () => {
                n += 1;
                return `id-${n}`;
            },
        });
        await Promise.all([
            store.appendText('one'),
            store.appendText('two'),
            store.appendText('three'),
        ]);
        const texts = await store.listTexts();
        expect(texts).toEqual(['one', 'two', 'three']);
    });
});
