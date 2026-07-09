import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TuiPluginManifestStore } from './plugin-manifest-store.js';
import {
    cleanupTuiStoreTestScope,
    createTuiStoreTestScope,
    expectNoMctrlWrites,
    expectNoTemporaryFiles,
    type TuiStoreTestScope,
} from './tui-store-test-support.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

describe('TuiPluginManifestStore', () => {
    let scope: TuiStoreTestScope | undefined;

    beforeEach(async () => {
        scope = await createTuiStoreTestScope('mctrl-tui-plugin');
    });

    afterEach(async () => {
        await cleanupTuiStoreTestScope(scope);
        scope = undefined;
    });

    it('round-trips manifests diagnostics and derived capabilities under MCTRL_DATA_DIR', async () => {
        // Given
        const store = new TuiPluginManifestStore({ maxEntries: 2 });

        // When
        await store.saveManifest({ name: 'demo', version: '1.0.0', capabilities: ['ui.slot', 'ui.kv'] });
        await store.appendDiagnostic({
            pluginName: 'demo',
            level: 'info',
            message: 'loaded',
            redacted: false,
            timestamp: 1,
        });

        // Then
        expect((await store.listManifests()).map((manifest) => manifest.name)).toEqual(['demo']);
        expect((await store.listCapabilities()).map((capability) => capability.capability)).toEqual([
            'ui.slot',
            'ui.kv',
        ]);
        expect((await store.listDiagnostics()).map((diagnostic) => diagnostic.message)).toEqual(['loaded']);
        await expectNoTemporaryFiles(store.filePath);
        await expectNoMctrlWrites(requireScope(scope), store.filePath);
    });

    it('truncates manifests and diagnostics to the configured bound', async () => {
        // Given
        const store = new TuiPluginManifestStore({ maxEntries: 2 });

        // When
        await store.saveManifest({ name: 'one', version: '1.0.0', capabilities: ['ui.slot'] });
        await store.saveManifest({ name: 'two', version: '1.0.0', capabilities: ['ui.route'] });
        await store.saveManifest({ name: 'three', version: '1.0.0', capabilities: ['ui.kv'] });
        await store.appendDiagnostic({
            pluginName: 'one',
            level: 'info',
            message: 'one',
            redacted: false,
            timestamp: 1,
        });
        await store.appendDiagnostic({
            pluginName: 'two',
            level: 'warning',
            message: 'two',
            redacted: false,
            timestamp: 2,
        });
        await store.appendDiagnostic({
            pluginName: 'three',
            level: 'error',
            message: 'three',
            redacted: true,
            timestamp: 3,
        });

        // Then
        expect((await store.listManifests()).map((manifest) => manifest.name)).toEqual(['two', 'three']);
        expect((await store.listDiagnostics()).map((diagnostic) => diagnostic.message)).toEqual(['two', 'three']);
    });

    it('returns empty records for malformed JSON or malformed manifest payloads', async () => {
        // Given
        const store = new TuiPluginManifestStore();
        await mkdir(dirname(store.filePath), { recursive: true });
        await writeFile(store.filePath, '{bad json', 'utf8');

        // When / Then
        await expect(store.listManifests()).resolves.toEqual([]);
        await writeFile(
            store.filePath,
            JSON.stringify({
                version: 1,
                manifests: [{ name: 'bad', version: '1.0.0', capabilities: ['bad'] }],
                diagnostics: [],
            }),
            'utf8',
        );
        await expect(store.listManifests()).resolves.toEqual([]);
    });
});

function requireScope(scope: TuiStoreTestScope | undefined): TuiStoreTestScope {
    if (scope !== undefined) {
        return scope;
    }
    throw new Error('test scope missing');
}
