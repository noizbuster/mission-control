import { resolveMissionControlDataDir } from './data-dir.js';
import { JsonlSessionEventStoreError } from './jsonl-session-event-store.js';
import { join } from 'node:path';

const LOCAL_SESSION_DB_FILENAME = 'memory.db';

export function localSessionDbPath(dataDir = resolveMissionControlDataDir()): string {
    return join(dataDir, LOCAL_SESSION_DB_FILENAME);
}

export function localSessionDbUrl(dataDir = resolveMissionControlDataDir()): string {
    return `file:${localSessionDbPath(dataDir)}`;
}

export function parseLocalSessionId(sessionId: string): string {
    if (/^[A-Za-z0-9._-]+$/.test(sessionId)) {
        return sessionId;
    }
    throw new JsonlSessionEventStoreError({
        code: 'invalid_session_id',
        message: `Invalid local session id ${sessionId}`,
        sessionId,
    });
}
