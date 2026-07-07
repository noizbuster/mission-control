import { describe, expect, it, vi } from 'vitest';
import { missionControlDataDirEnvKey } from '../memory/data-dir.js';
import { localSessionDbPath, localSessionDbUrl } from '../memory/local-session-store-paths.js';
import { localRuntimeDbPath, localRuntimeDbUrl } from './local-runtime-db.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('local runtime database path', () => {
    it('resolves runtime state to the shared local session memory DB', () => {
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
        } finally {
            vi.unstubAllEnvs();
            rmSync(dataDir, { recursive: true, force: true });
        }
    });
});
