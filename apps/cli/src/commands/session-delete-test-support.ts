import { missionControlDataDirEnvKey } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { vi } from 'vitest';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export async function useTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-cli-session-delete-'));
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return dataDir;
}

export function taskCompletedEvent(sessionId: string, message: string): AgentEvent {
    return {
        type: 'task.completed',
        timestamp: '2026-06-05T10:00:00.000Z',
        sessionId,
        message,
    };
}

export function metadataEvent(sessionId: string, parentSessionId: string): AgentEvent {
    return {
        type: 'session.metadata.updated',
        timestamp: '2026-06-05T10:00:00.000Z',
        sessionId,
        message: 'session metadata updated',
        sessionTree: { kind: 'metadata', parentSessionId },
    };
}

export function sessionLogPath(dataDir: string, sessionId: string): string {
    return join(dataDir, 'sessions', `${sessionId}.jsonl`);
}

export async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}

export async function setCanonicalSessionParent(
    dataDir: string,
    sessionId: string,
    parentSessionId: string,
): Promise<void> {
    const database = new DatabaseSync(join(dataDir, 'memory.db'));
    try {
        database
            .prepare('UPDATE sessions SET parent_session_id = ? WHERE session_id = ?')
            .run(parentSessionId, sessionId);
        database
            .prepare(
                'INSERT OR REPLACE INTO session_relations ' +
                    '(relation_id, parent_session_id, child_session_id, kind, created_at) VALUES (?, ?, ?, ?, ?)',
            )
            .run(
                `delete-test:${parentSessionId}:${sessionId}`,
                parentSessionId,
                sessionId,
                'parent_child',
                new Date(0).toISOString(),
            );
    } finally {
        database.close();
    }
}
