import { missionControlDataDirEnvKey } from '@mission-control/core';
import { vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function useIsolatedMissionControlDataDir(prefix: string): Promise<() => Promise<void>> {
    const dataDir = await mkdtemp(join(tmpdir(), prefix));
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return async () => {
        vi.unstubAllEnvs();
        await rm(dataDir, { recursive: true, force: true });
    };
}
