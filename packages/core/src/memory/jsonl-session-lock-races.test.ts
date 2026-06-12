import { afterEach, describe, expect, it } from 'vitest';
import { type OpenedJsonlSessionFile, openJsonlSessionFile, releaseSessionLock } from './jsonl-session-files.js';
import { acquireJsonlSessionLock, heartbeatJsonlSessionLock, releaseJsonlSessionLock } from './jsonl-session-lock.js';
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
    for (const tempDir of tempDirs.splice(0)) {
        await rm(tempDir, { recursive: true, force: true });
    }
});

describe('JSONL session lock recovery races', () => {
    it('allows only one concurrent stale reclaimer to own a session lock', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_lock_concurrent_reclaim';
        const lockPath = await writeLockRecord(dataDir, sessionId, {
            sessionId,
            ownerId: 'owner-stale',
            createdAt: '2026-06-12T09:00:00.000Z',
            updatedAt: '2026-06-12T09:00:00.000Z',
            heartbeatAt: '2026-06-12T09:00:00.000Z',
        });

        // When
        const results = await Promise.allSettled(
            Array.from({ length: 32 }, (_value, index) =>
                openJsonlSessionFile({
                    sessionId,
                    dataDir,
                    now: () => '2026-06-12T10:00:00.000Z',
                    lockOwnerId: `owner-reclaimer-${index}`,
                    lockStaleAfterMs: 30_000,
                }),
            ),
        );
        const opened = collectOpened(results);

        try {
            // Then
            expect(opened).toHaveLength(1);
            expect(opened[0]?.lockRecovery).toMatchObject({ reason: 'stale' });
            const [owner] = opened.map((entry) => entry.lockLease.ownerId);
            expect(await readLockRecord(lockPath)).toMatchObject({ ownerId: owner });
        } finally {
            await closeOpenedFiles(opened);
        }
    });

    it('preserves stale recovery when a competing reclaimer removes the lock before metadata read', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_lock_missing_after_contention';
        const lockPath = await writeLockRecord(dataDir, sessionId, {
            sessionId,
            ownerId: 'owner-stale-contention',
            createdAt: '2026-06-12T09:00:00.000Z',
            updatedAt: '2026-06-12T09:00:00.000Z',
            heartbeatAt: '2026-06-12T09:00:00.000Z',
        });
        let removed = false;

        // When
        const acquired = await acquireJsonlSessionLock({
            sessionId,
            lockPath,
            now: () => '2026-06-12T10:00:00.000Z',
            ownerId: 'owner-after-contention',
            staleAfterMs: 30_000,
            beforeExistingLockRead: async () => {
                if (!removed) {
                    removed = true;
                    await rm(lockPath, { force: true });
                }
            },
        });

        try {
            // Then
            expect(acquired.lockRecovery).toMatchObject({
                reason: 'stale',
                recoveredAt: '2026-06-12T10:00:00.000Z',
            });
        } finally {
            await releaseJsonlSessionLock(acquired.lockHandle, lockPath);
        }
    });

    it('reclaims an expired corrupt lock file instead of wedging the session', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_lock_corrupt_reclaim';
        const lockPath = await writeRawLock(dataDir, sessionId, '{"sessionId":');
        const staleTime = new Date('2026-06-12T09:00:00.000Z');
        await utimes(lockPath, staleTime, staleTime);

        // When
        const opened = await openJsonlSessionFile({
            sessionId,
            dataDir,
            now: () => '2026-06-12T10:00:00.000Z',
            lockOwnerId: 'owner-after-corrupt-crash',
            lockStaleAfterMs: 30_000,
        });

        try {
            // Then
            expect(opened.lockRecovery).toMatchObject({
                reason: 'stale_corrupt',
                recoveredAt: '2026-06-12T10:00:00.000Z',
            });
            expect(await readLockRecord(opened.lockPath)).toMatchObject({
                ownerId: 'owner-after-corrupt-crash',
                heartbeatAt: '2026-06-12T10:00:00.000Z',
            });
        } finally {
            await closeOpenedFiles([opened]);
        }
    });

    it('refuses a fresh corrupt lock file without deleting it', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_lock_corrupt_fresh';
        const contents = '{"sessionId":';
        const lockPath = await writeRawLock(dataDir, sessionId, contents);
        const freshTime = new Date('2026-06-12T09:59:55.000Z');
        await utimes(lockPath, freshTime, freshTime);

        // When
        const openLocked = openJsonlSessionFile({
            sessionId,
            dataDir,
            now: () => '2026-06-12T10:00:00.000Z',
            lockOwnerId: 'owner-after-fresh-corrupt',
            lockStaleAfterMs: 30_000,
        });

        // Then
        await expect(openLocked).rejects.toMatchObject({ code: 'lock_exists', sessionId });
        expect(await readFile(lockPath, 'utf8')).toBe(contents);
    });

    it('does not let a late heartbeat overwrite a reclaimed lock', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_lock_heartbeat_reclaim_race';
        const staleOwner = await openJsonlSessionFile({
            sessionId,
            dataDir,
            now: () => '2026-06-12T09:00:00.000Z',
            lockOwnerId: 'owner-late-heartbeat',
            lockStaleAfterMs: 30_000,
        });

        // When
        const [heartbeat, reclaimer] = await Promise.allSettled([
            heartbeatJsonlSessionLock({
                lockHandle: staleOwner.lockHandle,
                lockPath: staleOwner.lockPath,
                lockLease: staleOwner.lockLease,
                now: () => '2026-06-12T10:00:00.000Z',
            }),
            openJsonlSessionFile({
                sessionId,
                dataDir,
                now: () => '2026-06-12T10:00:00.000Z',
                lockOwnerId: 'owner-race-reclaimer',
                lockStaleAfterMs: 30_000,
            }),
        ]);
        const reclaimerOpened = reclaimer.status === 'fulfilled' ? reclaimer.value : undefined;

        try {
            // Then
            const successCount = Number(heartbeat.status === 'fulfilled') + Number(reclaimerOpened !== undefined);
            expect(successCount).toBe(1);
            expect(await readLockRecord(staleOwner.lockPath)).toMatchObject({
                ownerId: heartbeat.status === 'fulfilled' ? 'owner-late-heartbeat' : 'owner-race-reclaimer',
            });
        } finally {
            await closeOpenedFiles([staleOwner, ...(reclaimerOpened === undefined ? [] : [reclaimerOpened])]);
        }
    });
});

async function createTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-jsonl-lock-races-'));
    tempDirs.push(dataDir);
    return dataDir;
}

async function writeLockRecord(
    dataDir: string,
    sessionId: string,
    record: Readonly<Record<string, unknown>>,
): Promise<string> {
    return writeRawLock(dataDir, sessionId, `${JSON.stringify(record)}\n`);
}

async function writeRawLock(dataDir: string, sessionId: string, contents: string): Promise<string> {
    const sessionsDir = join(dataDir, 'sessions');
    await mkdir(sessionsDir, { recursive: true });
    const lockPath = join(sessionsDir, `${sessionId}.lock`);
    await writeFile(lockPath, contents, 'utf8');
    return lockPath;
}

function collectOpened(
    results: readonly PromiseSettledResult<OpenedJsonlSessionFile>[],
): readonly OpenedJsonlSessionFile[] {
    return results.flatMap((result) => (result.status === 'fulfilled' ? [result.value] : []));
}

async function readLockRecord(lockPath: string): Promise<Record<string, unknown>> {
    const parsed: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (isRecord(parsed)) {
        return parsed;
    }
    throw new TypeError('lock record must be an object');
}

async function closeOpenedFiles(openedFiles: readonly OpenedJsonlSessionFile[]): Promise<void> {
    for (const opened of openedFiles) {
        try {
            await opened.fileHandle.close();
        } finally {
            await releaseSessionLock(opened.lockHandle, opened.lockPath);
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
