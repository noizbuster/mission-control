import { missionControlDataDirEnvKey } from '@mission-control/core';
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
