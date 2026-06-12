import { afterEach, describe, expect, it, vi } from 'vitest';
import { JsonlSessionEventStore } from './jsonl-session-event-store.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
    vi.useRealTimers();
    for (const tempDir of tempDirs.splice(0)) {
        await rm(tempDir, { recursive: true, force: true });
    }
});

describe('JsonlSessionEventStore lock heartbeat renewal', () => {
    it('keeps an idle live writer fresh while no durable events are appended', async () => {
        // Given
        vi.useFakeTimers();
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_idle_heartbeat';
        let currentTime = '2026-06-12T10:00:00.000Z';
        const store = await JsonlSessionEventStore.open({
            sessionId,
            dataDir,
            now: () => currentTime,
            lockOwnerId: 'owner-idle-live',
            lockStaleAfterMs: 30_000,
            lockHeartbeatIntervalMs: 10_000,
        });

        try {
            // When
            currentTime = '2026-06-12T10:00:20.000Z';
            await vi.advanceTimersByTimeAsync(10_000);
            await store.getEvents(sessionId);
            const secondOpen = JsonlSessionEventStore.open({
                sessionId,
                dataDir,
                now: () => '2026-06-12T10:00:40.000Z',
                lockOwnerId: 'owner-second',
                lockStaleAfterMs: 30_000,
            });

            // Then
            await expect(secondOpen).rejects.toMatchObject({ code: 'lock_exists', sessionId });
            expect(await readLockRecord(join(dataDir, 'sessions', `${sessionId}.lock`))).toMatchObject({
                ownerId: 'owner-idle-live',
                heartbeatAt: '2026-06-12T10:00:20.000Z',
            });
        } finally {
            await store.close();
        }
    });

    it('stops the idle heartbeat after close', async () => {
        // Given
        vi.useFakeTimers();
        const dataDir = await createTempDataDir();
        const store = await JsonlSessionEventStore.open({
            sessionId: 'session_jsonl_closed_heartbeat',
            dataDir,
            lockHeartbeatIntervalMs: 10_000,
        });

        // When
        await store.close();

        // Then
        expect(vi.getTimerCount()).toBe(0);
    });

    it('surfaces heartbeat ownership failures on later reads', async () => {
        // Given
        vi.useFakeTimers();
        const dataDir = await createTempDataDir();
        const sessionId = 'session_jsonl_heartbeat_failure';
        const store = await JsonlSessionEventStore.open({
            sessionId,
            dataDir,
            lockOwnerId: 'owner-heartbeat-failure',
            lockHeartbeatIntervalMs: 10_000,
        });

        try {
            // When
            await rm(join(dataDir, 'sessions', `${sessionId}.lock`), { force: true });
            await vi.advanceTimersByTimeAsync(10_000);

            // Then
            await expect(store.getEvents(sessionId)).rejects.toMatchObject({ code: 'lock_exists', sessionId });
        } finally {
            await store.close();
        }
    });
});

async function createTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-jsonl-heartbeat-'));
    tempDirs.push(dataDir);
    return dataDir;
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
