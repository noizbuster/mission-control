import { sessionStoreDatabasePath } from '../runtime/session-store-identity.js';
import { resolveMissionControlDataDir } from './data-dir.js';
import { JsonlSessionEventStoreError } from './jsonl-session-event-store.js';
import { pathToFileURL } from 'node:url';

export function missionControlDbPath(dataDir = resolveMissionControlDataDir()): string {
    return sessionStoreDatabasePath(dataDir);
}

export function missionControlDbUrl(dataDir = resolveMissionControlDataDir()): string {
    return pathToFileURL(missionControlDbPath(dataDir)).href;
}

export function localSessionDbPath(dataDir = resolveMissionControlDataDir()): string {
    return missionControlDbPath(dataDir);
}

export function localSessionDbUrl(dataDir = resolveMissionControlDataDir()): string {
    return missionControlDbUrl(dataDir);
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
