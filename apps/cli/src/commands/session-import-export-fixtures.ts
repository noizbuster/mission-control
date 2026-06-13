import { missionControlDataDirEnvKey } from '@mission-control/core';
import { vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const JSONL_SESSION_LOG_HEADER_KIND = 'mission-control.session-log';
export const JSONL_SESSION_EVENT_RECORD_KIND = 'mission-control.session-event';
export const JSONL_SESSION_LOG_RECORD_VERSION = 1;
export const fixedNow = () => '2026-06-13T09:00:00.000Z';

export async function useTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-session-import-export-'));
    await mkdir(join(dataDir, 'sessions'), { recursive: true });
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return dataDir;
}

export function archiveManifest(sessionId: string, workspaceRoot: string) {
    return {
        schemaVersion: 1,
        sessionId,
        cwd: workspaceRoot,
        trustedRoot: workspaceRoot,
        createdAt: '2026-06-13T12:00:00.000Z',
    };
}

export function createArchiveJson(input: {
    readonly sessionId: string;
    readonly workspaceRoot: string;
    readonly eventsJsonl: string;
    readonly version?: number;
}): string {
    return JSON.stringify({
        kind: 'mission-control.session-archive',
        version: input.version ?? 1,
        manifest: archiveManifest(input.sessionId, input.workspaceRoot),
        checksum: {
            algorithm: 'sha256',
            value: createHash('sha256').update(input.eventsJsonl).digest('hex'),
        },
        eventsJsonl: input.eventsJsonl,
    });
}

export function createSessionLog(input: {
    readonly sessionId: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly cwd: string;
    readonly workspaceTrust: 'trusted' | 'denied' | 'unknown';
    readonly name: string;
    readonly activeLeafId: string;
    readonly parentSessionId?: string;
}): string {
    return [
        JSON.stringify({
            kind: JSONL_SESSION_LOG_HEADER_KIND,
            version: JSONL_SESSION_LOG_RECORD_VERSION,
            sessionId: input.sessionId,
            createdAt: input.createdAt,
        }),
        JSON.stringify(
            record({
                sessionId: input.sessionId,
                eventId: `${input.sessionId}_0`,
                sequence: 0,
                timestamp: input.createdAt,
                type: 'session.started',
                message: 'session started',
            }),
        ),
        JSON.stringify(
            record({
                sessionId: input.sessionId,
                eventId: `${input.sessionId}_1`,
                sequence: 1,
                timestamp: '2026-06-13T10:00:01.000Z',
                type: 'session.metadata.updated',
                message: 'session metadata updated',
                sessionTree: {
                    kind: 'metadata',
                    cwd: input.cwd,
                    workspaceTrust: input.workspaceTrust,
                    name: input.name,
                    ...(input.parentSessionId !== undefined ? { parentSessionId: input.parentSessionId } : {}),
                },
            }),
        ),
        JSON.stringify(
            record({
                sessionId: input.sessionId,
                eventId: `${input.sessionId}_2`,
                sequence: 2,
                timestamp: '2026-06-13T10:00:02.000Z',
                type: 'task.completed',
                message: 'root prompt',
                sessionTree: { kind: 'entry', entryId: 'entry_root' },
            }),
        ),
        JSON.stringify(
            record({
                sessionId: input.sessionId,
                eventId: `${input.sessionId}_3`,
                sequence: 3,
                timestamp: input.updatedAt,
                type: 'session.tree.active_leaf',
                message: 'active branch selected',
                sessionTree: { kind: 'active_leaf', entryId: input.activeLeafId },
            }),
        ),
        '',
    ].join('\n');
}

function record(input: {
    readonly sessionId: string;
    readonly eventId: string;
    readonly sequence: number;
    readonly timestamp: string;
    readonly type: string;
    readonly message: string;
    readonly sessionTree?: Record<string, unknown>;
}) {
    return {
        kind: JSONL_SESSION_EVENT_RECORD_KIND,
        version: JSONL_SESSION_LOG_RECORD_VERSION,
        event: {
            eventId: input.eventId,
            sequence: input.sequence,
            createdAt: input.timestamp,
            sessionId: input.sessionId,
            durability: 'durable',
            event: {
                type: input.type,
                timestamp: input.timestamp,
                sessionId: input.sessionId,
                message: input.message,
                nativeSidecarStatus: 'mock',
                ...(input.sessionTree !== undefined ? { sessionTree: input.sessionTree } : {}),
            },
        },
    };
}

export async function withProcessCwd<T>(cwd: string, callback: () => Promise<T>): Promise<T> {
    const previous = process.cwd();
    process.chdir(cwd);
    try {
        return await callback();
    } finally {
        process.chdir(previous);
    }
}
