import type { Client } from '@libsql/client';
import type { Run } from '@mission-control/protocol';
import { afterEach, vi } from 'vitest';
import { missionControlDataDirEnvKey } from '../memory/data-dir.js';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
    vi.unstubAllEnvs();
});

export async function makeMigrationFixture(): Promise<{
    readonly canonicalDataDir: string;
    readonly legacyRoot: string;
}> {
    const parent = await mkdtemp(join(tmpdir(), 'mctrl-runtime-migration-'));
    tempDirs.push(parent);
    const canonicalDataDir = join(parent, 'canonical');
    const legacyRoot = join(parent, 'legacy-root');
    await Promise.all([mkdir(canonicalDataDir, { mode: 0o700 }), mkdir(legacyRoot, { mode: 0o700 })]);
    vi.stubEnv(missionControlDataDirEnvKey, canonicalDataDir);
    return { canonicalDataDir, legacyRoot };
}

export async function writeLegacyRunJson(root: string, run: Run, fileName = `${run.id}.json`): Promise<string> {
    const runsDir = join(root, '.omo', 'runs');
    await mkdir(runsDir, { recursive: true });
    const filePath = join(runsDir, fileName);
    await writeFile(filePath, JSON.stringify(run), 'utf8');
    return filePath;
}

export async function sha256File(path: string): Promise<string> {
    return createHash('sha256')
        .update(await readFile(path))
        .digest('hex');
}

export async function rowCount(client: Client, table: string): Promise<number> {
    const result = await client.execute(`SELECT COUNT(*) AS count FROM ${table}`);
    const count = result.rows[0]?.[0];
    if (typeof count !== 'number') {
        throw new Error(`Expected numeric count for ${table}`);
    }
    return count;
}
