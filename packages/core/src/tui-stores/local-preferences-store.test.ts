import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { emptyTuiLocalPreferences, TuiLocalPreferencesStore } from './local-preferences-store';
import {
    cleanupTuiStoreTestScope,
    createTuiStoreTestScope,
    expectNoMctrlWrites,
    expectNoTemporaryFiles,
    type TuiStoreTestScope,
} from './tui-store-test-support';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

describe('TuiLocalPreferencesStore', () => {
    let scope: TuiStoreTestScope | undefined;

    beforeEach(async () => {
        scope = await createTuiStoreTestScope('mctrl-tui-prefs');
    });

    afterEach(async () => {
        await cleanupTuiStoreTestScope(scope);
        scope = undefined;
    });

    it('round-trips preferences atomically under MCTRL_DATA_DIR', async () => {
        // Given
        const store = new TuiLocalPreferencesStore({ maxEntries: 2 });

        // When
        await store.addRecentModel('openai/gpt-5.5');
        await store.setUiToggle({ key: 'show-graph', value: true });

        // Then
        expect(await store.getPreferences()).toMatchObject({
            recentModels: ['openai/gpt-5.5'],
            uiToggles: [{ key: 'show-graph', value: true }],
        });
        await expectNoTemporaryFiles(store.filePath);
        await expectNoMctrlWrites(requireScope(scope), store.filePath);
    });

    it('truncates every retained preference collection', async () => {
        // Given
        const store = new TuiLocalPreferencesStore({ maxEntries: 2 });

        // When
        await store.savePreferences({
            recentModels: ['m1', 'm2', 'm3'],
            favoriteModels: ['f1', 'f2', 'f3'],
            variantCyclingHints: [
                { modelId: 'v1', variantId: 'low' },
                { modelId: 'v2', variantId: 'medium' },
                { modelId: 'v3', variantId: 'high' },
            ],
            sessionPins: ['s1', 's2', 's3'],
            uiToggles: [
                { key: 'a', value: true },
                { key: 'b', value: false },
                { key: 'c', value: true },
            ],
            modelContextPrefs: [
                { modelKey: 'p/m1', contextLimit: 8_000 },
                { modelKey: 'p/m2', autoCompactThreshold: 0.8 },
                { modelKey: 'p/m3', contextLimit: 128_000, autoCompactThreshold: 0.9 },
            ],
        });

        // Then
        expect(await store.getPreferences()).toEqual({
            recentModels: ['m2', 'm3'],
            favoriteModels: ['f2', 'f3'],
            variantCyclingHints: [
                { modelId: 'v2', variantId: 'medium' },
                { modelId: 'v3', variantId: 'high' },
            ],
            sessionPins: ['s2', 's3'],
            uiToggles: [
                { key: 'b', value: false },
                { key: 'c', value: true },
            ],
            modelContextPrefs: [
                { modelKey: 'p/m2', autoCompactThreshold: 0.8 },
                { modelKey: 'p/m3', contextLimit: 128_000, autoCompactThreshold: 0.9 },
            ],
        });
    });

    it('returns defaults for malformed JSON', async () => {
        // Given
        const store = new TuiLocalPreferencesStore();
        await mkdir(dirname(store.filePath), { recursive: true });
        await writeFile(store.filePath, '{bad json', 'utf8');

        // When / Then
        await expect(store.getPreferences()).resolves.toEqual(emptyTuiLocalPreferences());
    });
});

describe('TuiLocalPreferencesStore concurrency', () => {
    it('serializes concurrent setUiToggle without dropping updates', async () => {
        const { mkdtemp } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const dir = await mkdtemp(join(tmpdir(), 'mctrl-local-prefs-'));
        const store = new TuiLocalPreferencesStore({ dataDir: dir });
        await Promise.all([
            store.setUiToggle({ key: 'a', value: true }),
            store.setUiToggle({ key: 'b', value: true }),
            store.setUiToggle({ key: 'c', value: false }),
        ]);
        const prefs = await store.getPreferences();
        const keys = prefs.uiToggles.map((toggle) => toggle.key).sort();
        expect(keys).toEqual(['a', 'b', 'c']);
    });
});

function requireScope(scope: TuiStoreTestScope | undefined): TuiStoreTestScope {
    if (scope !== undefined) {
        return scope;
    }
    throw new Error('test scope missing');
}
