import { resolveMissionControlDataDir } from '../memory/data-dir.js';
import { missionControlDbUrl } from '../memory/local-session-store-paths.js';
import type { LocalLibsqlDb } from './local-libsql-db.js';
import { openLocalLibsqlDb } from './local-libsql-db.js';
import { mkdir } from 'node:fs/promises';

export type OpenMissionControlDbOptions = {
    readonly dataDir?: string;
};

export async function openMissionControlDb(options: OpenMissionControlDbOptions = {}): Promise<LocalLibsqlDb> {
    const dataDir = options.dataDir ?? resolveMissionControlDataDir();
    await mkdir(dataDir, { recursive: true });
    return openLocalLibsqlDb({ url: missionControlDbUrl(dataDir) });
}
