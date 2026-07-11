import { afterEach, describe, expect, it, vi } from 'vitest';
import { missionControlDbPath as coreMissionControlDbPath } from '../index.js';
import { missionControlDataDirEnvKey } from './data-dir.js';
import { missionControlDbPath as memoryMissionControlDbPath } from './index.js';
import {
    localSessionDbPath,
    localSessionDbUrl,
    missionControlDbPath,
    missionControlDbUrl,
} from './local-session-store-paths.js';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('Mission Control database paths', () => {
    it('resolves product helpers and compatibility aliases to mission-control.db', () => {
        // Given
        const dataDir = join('tmp', 'isolated-mctrl-data');
        const expectedPath = join(dataDir, 'mission-control.db');
        const expectedUrl = pathToFileURL(expectedPath).href;

        // When
        const paths = [
            missionControlDbPath(dataDir),
            localSessionDbPath(dataDir),
            memoryMissionControlDbPath(dataDir),
            coreMissionControlDbPath(dataDir),
        ];
        const urls = [missionControlDbUrl(dataDir), localSessionDbUrl(dataDir)];

        // Then
        expect(paths).toEqual([expectedPath, expectedPath, expectedPath, expectedPath]);
        expect(urls).toEqual([expectedUrl, expectedUrl]);
    });

    it('keeps MCTRL_DATA_DIR authoritative for every default helper', () => {
        // Given
        const dataDir = join('tmp', 'isolated-mctrl-env-data');
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);
        const expectedPath = join(dataDir, 'mission-control.db');

        // When
        const productPath = missionControlDbPath();
        const productUrl = missionControlDbUrl();
        const compatibilityPath = localSessionDbPath();
        const compatibilityUrl = localSessionDbUrl();

        // Then
        expect(productPath).toBe(expectedPath);
        expect(productUrl).toBe(pathToFileURL(expectedPath).href);
        expect(compatibilityPath).toBe(expectedPath);
        expect(compatibilityUrl).toBe(pathToFileURL(expectedPath).href);
    });
});
