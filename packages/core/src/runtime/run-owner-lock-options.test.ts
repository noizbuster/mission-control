import type { ModelProviderSelection } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { providerFromRequests } from './run-coordinator-test-support.js';
import { SessionRunOwnerRegistry } from './run-owner.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];
const modelProviderSelection: ModelProviderSelection = { providerID: 'local', modelID: 'deterministic' };

afterEach(async () => {
    vi.useRealTimers();
    for (const dataDir of tempDirs.splice(0)) {
        await rm(dataDir, { recursive: true, force: true });
    }
});

describe('SessionRunOwnerRegistry lock options', () => {
    it('passes the configured stale window to JSONL store opening', async () => {
        // Given
        const dataDir = await makeDataDir();
        const sessionId = 'session_owner_custom_stale_window';
        const lockPath = await writeLockRecord(dataDir, sessionId, {
            sessionId,
            ownerId: 'owner-still-fresh-for-custom-window',
            createdAt: '2026-06-12T09:59:20.000Z',
            updatedAt: '2026-06-12T09:59:20.000Z',
            heartbeatAt: '2026-06-12T09:59:20.000Z',
        });
        const registry = createRegistry(dataDir, {
            lockStaleAfterMs: 60_000,
            now: () => '2026-06-12T10:00:00.000Z',
        });

        // When / Then
        await expect(registry.status({ sessionId })).rejects.toMatchObject({ code: 'lock_exists', sessionId });
        expect(await readLockRecord(lockPath)).toMatchObject({ ownerId: 'owner-still-fresh-for-custom-window' });
    });

    it('passes the configured heartbeat interval to JSONL store opening', async () => {
        // Given
        vi.useFakeTimers();
        const dataDir = await makeDataDir();
        const sessionId = 'session_owner_custom_heartbeat_interval';
        let currentTime = '2026-06-12T10:00:00.000Z';
        const registry = createRegistry(dataDir, {
            lockHeartbeatIntervalMs: 5_000,
            lockStaleAfterMs: 60_000,
            now: () => currentTime,
        });

        // When
        await registry.withOwner({ sessionId }, async (_owner, store) => {
            currentTime = '2026-06-12T10:00:05.000Z';
            await vi.advanceTimersByTimeAsync(5_000);
            await store.getEvents(sessionId);

            // Then
            expect(await readLockRecord(join(dataDir, 'sessions', `${sessionId}.lock`))).toMatchObject({
                heartbeatAt: '2026-06-12T10:00:05.000Z',
            });
        });
    });
});

function createRegistry(
    dataDir: string,
    options: {
        readonly now: () => string;
        readonly lockStaleAfterMs?: number;
        readonly lockHeartbeatIntervalMs?: number;
    },
): SessionRunOwnerRegistry {
    return new SessionRunOwnerRegistry({
        dataDir,
        provider: providerFromRequests(() => Promise.resolve()),
        modelProviderSelection,
        now: options.now,
        ...(options.lockStaleAfterMs !== undefined ? { lockStaleAfterMs: options.lockStaleAfterMs } : {}),
        ...(options.lockHeartbeatIntervalMs !== undefined
            ? { lockHeartbeatIntervalMs: options.lockHeartbeatIntervalMs }
            : {}),
    });
}

async function makeDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-run-owner-lock-options-'));
    tempDirs.push(dataDir);
    return dataDir;
}

async function writeLockRecord(
    dataDir: string,
    sessionId: string,
    record: Readonly<Record<string, unknown>>,
): Promise<string> {
    const sessionsDir = join(dataDir, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const lockPath = join(sessionsDir, `${sessionId}.lock`);
    await writeFile(lockPath, `${JSON.stringify(record)}\n`, 'utf8');
    return lockPath;
}

async function readLockRecord(lockPath: string): Promise<Record<string, unknown>> {
    const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (isRecord(parsed)) {
        return parsed;
    }
    throw new TypeError('lock record must be an object');
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
