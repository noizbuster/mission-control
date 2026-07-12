import { missionControlDataDirEnvKey, openCanonicalRuntimeDb, runLocalLibsqlWrite } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { vi } from 'vitest';
import { access, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
    const { runtime } = await openCanonicalRuntimeDb({ dataDir, sessionControlMaintenance: false });
    try {
        await runLocalLibsqlWrite(runtime, (client) =>
            client
                .batch(
                    [
                        {
                            sql: 'UPDATE sessions SET parent_session_id = ? WHERE session_id = ?',
                            args: [parentSessionId, sessionId],
                        },
                        {
                            sql:
                                'INSERT OR REPLACE INTO session_relations ' +
                                '(relation_id, parent_session_id, child_session_id, kind, created_at) ' +
                                'VALUES (?, ?, ?, ?, ?)',
                            args: [
                                `delete-test:${parentSessionId}:${sessionId}`,
                                parentSessionId,
                                sessionId,
                                'parent_child',
                                new Date(0).toISOString(),
                            ],
                        },
                    ],
                    'write',
                )
                .then(() => undefined),
        );
    } finally {
        runtime.close();
    }
}
