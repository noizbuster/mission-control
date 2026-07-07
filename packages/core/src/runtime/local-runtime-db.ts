import type { LocalLibsqlDb } from '../db/local-libsql-db.js';
import { openLocalLibsqlDb } from '../db/local-libsql-db.js';
import { localSessionDbPath, localSessionDbUrl } from '../memory/local-session-store-paths.js';
import { mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export function localRuntimeDbPath(dataDir?: string): string {
    return localSessionDbPath(dataDir);
}

export function localRuntimeDbUrl(dataDir?: string): string {
    return localSessionDbUrl(dataDir);
}

export async function openRuntimeLocalDb(dataDir?: string): Promise<LocalLibsqlDb> {
    await mkdir(dirname(localRuntimeDbPath(dataDir)), { recursive: true });
    return openLocalLibsqlDb({ url: localRuntimeDbUrl(dataDir) });
}
