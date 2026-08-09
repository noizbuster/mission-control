import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TuiPromptStashStore } from './prompt-stash-store';
import {
    cleanupTuiStoreTestScope,
    createTuiStoreTestScope,
    expectNoMctrlWrites,
    expectNoTemporaryFiles,
    type TuiStoreTestScope,
} from './tui-store-test-support';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

describe('TuiPromptStashStore', () => {
    let scope: TuiStoreTestScope | undefined;
    let idCounter = 0;

    beforeEach(async () => {
        idCounter = 0;
        scope = await createTuiStoreTestScope('mctrl-tui-stash');
    });

    afterEach(async () => {
        await cleanupTuiStoreTestScope(scope);
        scope = undefined;
    });

    it('pushes and pops LIFO entries atomically under MCTRL_DATA_DIR', async () => {
        // Given
        const store = createStore();

        // When
        await store.pushEntry({ text: 'first', cursorOffset: 1 });
        await store.pushEntry({ text: 'second', cursorOffset: 2 });
        const popped = await store.popEntry();

        // Then
        expect(popped?.text).toBe('second');
        expect((await store.listEntries()).map((entry) => entry.text)).toEqual(['first']);
        await expectNoTemporaryFiles(store.filePath);
        await expectNoMctrlWrites(requireScope(scope), store.filePath);
    });

    it('truncates stash entries to the configured bound', async () => {
        // Given
        const store = createStore(2);

        // When
        await store.pushEntry({ text: 'one', cursorOffset: 1 });
        await store.pushEntry({ text: 'two', cursorOffset: 2 });
        await store.pushEntry({ text: 'three', cursorOffset: 3 });

        // Then
        expect((await store.listEntries()).map((entry) => entry.text)).toEqual(['two', 'three']);
    });

    it('skips malformed JSONL lines and preserves valid stash entries', async () => {
        // Given
        const store = createStore();
        await mkdir(dirname(store.filePath), { recursive: true });
        await writeFile(
            store.filePath,
            `${JSON.stringify({ id: 'good-1', text: 'one', cursorOffset: 1, timestamp: 1 })}\nnot-json\n${JSON.stringify({ id: 'bad' })}\n${JSON.stringify({ id: 'good-2', text: 'two', cursorOffset: 2, timestamp: 2 })}\n`,
            'utf8',
        );

        // When / Then
        expect((await store.listEntries()).map((entry) => entry.text)).toEqual(['one', 'two']);
    });

    function createStore(maxEntries = 10): TuiPromptStashStore {
        return new TuiPromptStashStore({
            maxEntries,
            now: () => 10,
            idFactory: () => {
                idCounter += 1;
                return `stash-${idCounter}`;
            },
        });
    }

    it('serializes concurrent pushEntry without dropping entries', async () => {
        const store = createStore();
        await Promise.all([
            store.pushEntry({ text: 'a', cursorOffset: 0 }),
            store.pushEntry({ text: 'b', cursorOffset: 0 }),
            store.pushEntry({ text: 'c', cursorOffset: 0 }),
        ]);
        const entries = await store.listEntries();
        expect(entries.map((entry) => entry.text).sort()).toEqual(['a', 'b', 'c']);
    });
});

function requireScope(scope: TuiStoreTestScope | undefined): TuiStoreTestScope {
    if (scope !== undefined) {
        return scope;
    }
    throw new Error('test scope missing');
}
