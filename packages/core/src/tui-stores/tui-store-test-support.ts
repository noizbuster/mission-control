import { expect, vi } from 'vitest';
import { missionControlDataDirEnvKey } from '../memory/data-dir.js';
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export type TuiStoreTestScope = {
    readonly dataDir: string;
    readonly workspaceDir: string;
};

export async function createTuiStoreTestScope(prefix: string): Promise<TuiStoreTestScope> {
    const dataDir = await mkdtemp(join(tmpdir(), `${prefix}-data-`));
    const workspaceDir = await mkdtemp(join(tmpdir(), `${prefix}-workspace-`));
    await mkdir(join(workspaceDir, '.mctrl'), { recursive: true });
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return { dataDir, workspaceDir };
}

export async function cleanupTuiStoreTestScope(scope: TuiStoreTestScope | undefined): Promise<void> {
    vi.unstubAllEnvs();
    if (scope === undefined) {
        return;
    }
    await Promise.all([
        rm(scope.dataDir, { recursive: true, force: true }),
        rm(scope.workspaceDir, { recursive: true, force: true }),
    ]);
}

export async function expectNoTemporaryFiles(filePath: string): Promise<void> {
    const entries = await readdir(dirname(filePath));
    expect(entries.filter((entry) => entry.endsWith('.tmp'))).toEqual([]);
}

export async function expectNoMctrlWrites(scope: TuiStoreTestScope, filePath: string): Promise<void> {
    expect(filePath.startsWith(scope.dataDir)).toBe(true);
    expect(await readdir(join(scope.workspaceDir, '.mctrl'))).toEqual([]);
}
