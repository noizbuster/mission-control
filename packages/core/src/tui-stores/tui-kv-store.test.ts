import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TuiKvStore } from './tui-kv-store.js';
import {
    cleanupTuiStoreTestScope,
    createTuiStoreTestScope,
    expectNoMctrlWrites,
    expectNoTemporaryFiles,
    type TuiStoreTestScope,
} from './tui-store-test-support.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

describe('TuiKvStore', () => {
    let scope: TuiStoreTestScope | undefined;

    beforeEach(async () => {
        scope = await createTuiStoreTestScope('mctrl-tui-kv');
    });

    afterEach(async () => {
        await cleanupTuiStoreTestScope(scope);
        scope = undefined;
    });

    it('writes schema-keyed values atomically under MCTRL_DATA_DIR', async () => {
        // Given
        const store = new TuiKvStore({ maxEntries: 2 });

        // When
        await store.setEntry('composer', { key: 'draft', schemaKey: 'string', value: 'hello' });

        // Then
        expect(await store.getString('composer', 'draft')).toBe('hello');
        await expectNoTemporaryFiles(store.filePath);
        await expectNoMctrlWrites(requireScope(scope), store.filePath);
    });

    it('truncates namespace entries to the configured retention bound', async () => {
        // Given
        const store = new TuiKvStore({ maxEntries: 2 });

        // When
        await store.setEntry('composer', { key: 'one', schemaKey: 'number', value: 1 });
        await store.setEntry('composer', { key: 'two', schemaKey: 'number', value: 2 });
        await store.setEntry('composer', { key: 'three', schemaKey: 'number', value: 3 });

        // Then
        expect((await store.listEntries('composer')).map((entry) => entry.key)).toEqual(['two', 'three']);
    });

    it('self-heals malformed JSON by returning an empty namespace list', async () => {
        // Given
        const store = new TuiKvStore();
        await mkdir(dirname(store.filePath), { recursive: true });
        await writeFile(store.filePath, '{bad json', 'utf8');

        // When / Then
        await expect(store.listNamespaces()).resolves.toEqual([]);
    });
});

function requireScope(scope: TuiStoreTestScope | undefined): TuiStoreTestScope {
    if (scope !== undefined) {
        return scope;
    }
    throw new Error('test scope missing');
}
