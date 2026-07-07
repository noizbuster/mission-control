import { missionControlDataDirEnvKey, type SessionIndexSessionRecord } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { vi } from 'vitest';
import { access, mkdtemp, writeFile } from 'node:fs/promises';
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

export function sessionIndexRecord(dataDir: string, sessionId: string): SessionIndexSessionRecord {
    return {
        kind: 'session',
        sessionId,
        status: 'stopped',
        startedAt: '2026-06-05T10:00:00.000Z',
        eventCount: 1,
        updatedAt: '2026-06-05T10:01:00.000Z',
        sourceFilePath: join(dataDir, 'sessions', `${sessionId}.jsonl`),
    };
}

export async function writeSessionLock(dataDir: string, sessionId: string, heartbeatAt: string): Promise<void> {
    await writeFile(
        join(dataDir, 'sessions', `${sessionId}.lock`),
        `${JSON.stringify({
            sessionId,
            ownerId: `owner-${sessionId}`,
            createdAt: '2020-01-01T00:00:00.000Z',
            updatedAt: heartbeatAt,
            heartbeatAt,
        })}\n`,
        'utf8',
    );
}

export function sessionLogPath(dataDir: string, sessionId: string): string {
    return join(dataDir, 'sessions', `${sessionId}.jsonl`);
}

export function sessionLockPath(dataDir: string, sessionId: string): string {
    return join(dataDir, 'sessions', `${sessionId}.lock`);
}

export async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}
