import { TuiThemePreferenceSchema } from '@mission-control/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { defaultTuiThemePreference, TuiThemePreferenceStore } from './theme-preference-store.js';
import {
    cleanupTuiStoreTestScope,
    createTuiStoreTestScope,
    expectNoMctrlWrites,
    expectNoTemporaryFiles,
    type TuiStoreTestScope,
} from './tui-store-test-support.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

describe('TuiThemePreferenceStore', () => {
    let scope: TuiStoreTestScope | undefined;

    beforeEach(async () => {
        scope = await createTuiStoreTestScope('mctrl-tui-theme');
    });

    afterEach(async () => {
        await cleanupTuiStoreTestScope(scope);
        scope = undefined;
    });

    it('round-trips theme preferences atomically under MCTRL_DATA_DIR', async () => {
        // Given
        const store = new TuiThemePreferenceStore({ maxEntries: 2 });

        // When
        await store.savePreference({
            activeThemeId: 'midnight',
            customOverrides: [{ key: 'accent', value: '#88ccff' }],
        });

        // Then
        expect(await store.getPreference()).toEqual({
            activeThemeId: 'midnight',
            customOverrides: [{ key: 'accent', value: '#88ccff' }],
        });
        await expectNoTemporaryFiles(store.filePath);
        await expectNoMctrlWrites(requireScope(scope), store.filePath);
    });

    it('truncates custom override records to the configured bound', async () => {
        // Given
        const store = new TuiThemePreferenceStore({ maxEntries: 2 });

        // When
        await store.savePreference({
            activeThemeId: 'midnight',
            customOverrides: [
                { key: 'a', value: '1' },
                { key: 'b', value: '2' },
                { key: 'c', value: '3' },
            ],
        });

        // Then
        expect((await store.getPreference()).customOverrides).toEqual([
            { key: 'b', value: '2' },
            { key: 'c', value: '3' },
        ]);
    });

    it('returns the default preference for malformed JSON or malformed theme payloads', async () => {
        // Given
        const store = new TuiThemePreferenceStore();
        await mkdir(dirname(store.filePath), { recursive: true });
        await writeFile(store.filePath, '{bad json', 'utf8');

        // When / Then
        await expect(store.getPreference()).resolves.toEqual(defaultTuiThemePreference());
        expect(
            TuiThemePreferenceSchema.safeParse({ activeThemeId: 'midnight', customOverrides: [{ key: 'accent' }] })
                .success,
        ).toBe(false);
        await writeFile(
            store.filePath,
            JSON.stringify({ version: 1, preference: { activeThemeId: 'x', customOverrides: [{ key: 'a' }] } }),
            'utf8',
        );
        await expect(store.getPreference()).resolves.toEqual(defaultTuiThemePreference());
    });
});

function requireScope(scope: TuiStoreTestScope | undefined): TuiStoreTestScope {
    if (scope !== undefined) {
        return scope;
    }
    throw new Error('test scope missing');
}
