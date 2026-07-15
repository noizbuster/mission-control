import { describe, expect, it, vi } from 'vitest';
import { openMissionControlDb } from '../db/mission-control-db';
import { missionControlDataDirEnvKey } from '../memory/data-dir';
import {
    localSessionDbPath,
    localSessionDbUrl,
    missionControlDbPath,
    missionControlDbUrl,
} from '../memory/local-session-store-paths';
import { localRuntimeDbPath, localRuntimeDbUrl, openRuntimeLocalDb } from './local-runtime-db';
import { sessionStoreIdentityFromCanonicalDatabasePath } from './session-store-identity';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('local runtime database path', () => {
    it('resolves runtime state to the shared Mission Control database', () => {
        // Given
        const dataDir = mkdtempSync(join(tmpdir(), 'mctrl-runtime-shared-db-'));
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);
        try {
            // When
            const runtimePath = localRuntimeDbPath();
            const runtimeUrl = localRuntimeDbUrl();

            // Then
            expect(runtimePath).toBe(localSessionDbPath(dataDir));
            expect(runtimeUrl).toBe(localSessionDbUrl(dataDir));
            expect(runtimePath).toBe(missionControlDbPath(dataDir));
            expect(runtimeUrl).toBe(missionControlDbUrl(dataDir));
        } finally {
            vi.unstubAllEnvs();
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    it('creates only mission-control.db under an isolated data directory with required pragmas', async () => {
        // Given
        const root = mkdtempSync(join(tmpdir(), 'mctrl-central-db-'));
        const workspace = join(root, 'workspace');
        const dataDir = join(root, 'nested', 'data');
        try {
            // When
            const runtime = await openMissionControlDb({ dataDir });
            const journalMode = await runtime.client.execute('PRAGMA journal_mode');
            const synchronous = await runtime.client.execute('PRAGMA synchronous');
            const busyTimeout = await runtime.client.execute('PRAGMA busy_timeout');

            // Then
            expect(existsSync(missionControlDbPath(dataDir))).toBe(true);
            expect(existsSync(join(dataDir, 'memory.db'))).toBe(false);
            expect(existsSync(join(workspace, 'memory.db'))).toBe(false);
            expect(journalMode.rows[0]?.[0]).toBe('wal');
            expect(synchronous.rows[0]?.[0]).toBe(1);
            expect(busyTimeout.rows[0]?.[0]).toBe(5000);
            runtime.close();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });

    it('keeps openRuntimeLocalDb as a product-opener compatibility wrapper', async () => {
        // Given
        const dataDir = mkdtempSync(join(tmpdir(), 'mctrl-runtime-wrapper-'));
        const legacyIdentity = sessionStoreIdentityFromCanonicalDatabasePath(join(dataDir, 'memory.db'));
        try {
            // When
            const runtime = await openRuntimeLocalDb(legacyIdentity);

            // Then
            expect(runtime.url).toBe(missionControlDbUrl(dataDir));
            expect(existsSync(missionControlDbPath(dataDir))).toBe(true);
            expect(existsSync(legacyIdentity.databasePath)).toBe(false);
            runtime.close();
        } finally {
            rmSync(dataDir, { recursive: true, force: true });
        }
    });

    it('prefers the canonical data directory carried by a full runtime identity', async () => {
        // Given
        const root = mkdtempSync(join(tmpdir(), 'mctrl-runtime-canonical-dir-'));
        const dataDir = join(root, 'canonical-data');
        const realpathedTargetDir = join(root, 'database-target');
        const identity = {
            canonicalDataDir: dataDir,
            ...sessionStoreIdentityFromCanonicalDatabasePath(join(realpathedTargetDir, 'actual.db')),
        };
        try {
            // When
            const runtime = await openRuntimeLocalDb(identity);

            // Then
            expect(runtime.url).toBe(missionControlDbUrl(dataDir));
            expect(existsSync(missionControlDbPath(dataDir))).toBe(true);
            expect(existsSync(missionControlDbPath(realpathedTargetDir))).toBe(false);
            runtime.close();
        } finally {
            rmSync(root, { recursive: true, force: true });
        }
    });
});
