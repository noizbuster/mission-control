import { resolveMissionControlDataDir } from '../memory/data-dir';
import { missionControlDbUrl } from '../memory/local-session-store-paths';
import type { LocalLibsqlDb } from './local-libsql-db';
import { openLocalLibsqlDb } from './local-libsql-db';
import { mkdir } from 'node:fs/promises';

export type OpenMissionControlDbOptions = {
    readonly dataDir?: string;
};

export async function openMissionControlDb(options: OpenMissionControlDbOptions = {}): Promise<LocalLibsqlDb> {
    const dataDir = options.dataDir ?? resolveMissionControlDataDir();
    await mkdir(dataDir, { recursive: true });
    return openLocalLibsqlDb({ url: missionControlDbUrl(dataDir) });
}
