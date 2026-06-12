import { afterEach, describe, expect, it } from 'vitest';
import { type OpenedJsonlSessionFile, openJsonlSessionFile, releaseSessionLock } from './jsonl-session-files.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
    for (const tempDir of tempDirs.splice(0)) {
        await rm(tempDir, { recursive: true, force: true });
    }
});

describe('JSONL session file locks', () => {
    it('refuses to steal live session lock', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_lock_live_owner';
        const first = await openJsonlSessionFile({
            sessionId,
            dataDir,
            now: () => '2026-06-12T10:00:00.000Z',
            lockOwnerId: 'owner-live',
            lockPid: 1001,
            lockStaleAfterMs: 60_000,
        });

        try {
            // When
            const secondOpen = openJsonlSessionFile({
                sessionId,
                dataDir,
                now: () => '2026-06-12T10:00:10.000Z',
                lockOwnerId: 'owner-second',
                lockStaleAfterMs: 60_000,
            });

            // Then
            await expect(secondOpen).rejects.toMatchObject({ code: 'lock_exists', sessionId });
            expect(await readLockRecord(first.lockPath)).toMatchObject({
                ownerId: 'owner-live',
                pid: 1001,
                heartbeatAt: '2026-06-12T10:00:00.000Z',
            });
        } finally {
            await closeOpenedFile(first);
        }
    });

    it('reclaims stale session lock and records previous owner metadata', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_lock_stale_reclaim';
        const lockPath = await writeLockRecord(dataDir, sessionId, {
            sessionId,
            ownerId: 'owner-stale',
            pid: 2002,
            createdAt: '2026-06-12T09:58:00.000Z',
            updatedAt: '2026-06-12T09:58:00.000Z',
            heartbeatAt: '2026-06-12T09:58:00.000Z',
        });

        // When
        const opened = await openJsonlSessionFile({
            sessionId,
            dataDir,
            now: () => '2026-06-12T10:00:00.000Z',
            lockOwnerId: 'owner-reclaimer',
            lockPid: 3003,
            lockStaleAfterMs: 30_000,
        });

        try {
            // Then
            expect(opened.lockPath).toBe(lockPath);
            expect(opened.lockRecovery).toMatchObject({
                reason: 'stale',
                recoveredAt: '2026-06-12T10:00:00.000Z',
                previousLock: {
                    ownerId: 'owner-stale',
                    pid: 2002,
                    heartbeatAt: '2026-06-12T09:58:00.000Z',
                },
            });
            expect(await readLockRecord(opened.lockPath)).toMatchObject({
                ownerId: 'owner-reclaimer',
                pid: 3003,
                heartbeatAt: '2026-06-12T10:00:00.000Z',
            });
        } finally {
            await closeOpenedFile(opened);
        }
    });

    it('does not let a stale owner release remove a reclaimed lock', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_lock_reclaimed_release';
        const staleOwner = await openJsonlSessionFile({
            sessionId,
            dataDir,
            now: () => '2026-06-12T09:00:00.000Z',
            lockOwnerId: 'owner-stale-open-handle',
        });
        const reclaimer = await openJsonlSessionFile({
            sessionId,
            dataDir,
            now: () => '2026-06-12T10:00:00.000Z',
            lockOwnerId: 'owner-reclaimer',
        });

        try {
            // When
            await closeOpenedFile(staleOwner);

            // Then
            expect(await readLockRecord(reclaimer.lockPath)).toMatchObject({
                ownerId: 'owner-reclaimer',
                heartbeatAt: '2026-06-12T10:00:00.000Z',
            });
        } finally {
            await closeOpenedFile(reclaimer);
        }
    });

    it('does not remove a reclaimed lock when reclaim happens during stale owner close', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_lock_reclaimed_during_close';
        const staleOwner = await openJsonlSessionFile({
            sessionId,
            dataDir,
            now: () => '2026-06-12T09:00:00.000Z',
            lockOwnerId: 'owner-stale-close-window',
        });
        let reclaimer: OpenedJsonlSessionFile | undefined;
        const closeStaleOwnerHandle = staleOwner.lockHandle.close.bind(staleOwner.lockHandle);
        Object.defineProperty(staleOwner.lockHandle, 'close', {
            value: async () => {
                reclaimer = await openJsonlSessionFile({
                    sessionId,
                    dataDir,
                    now: () => '2026-06-12T10:00:00.000Z',
                    lockOwnerId: 'owner-reclaimer-during-close',
                });
                await closeStaleOwnerHandle();
            },
        });

        try {
            // When
            await closeOpenedFile(staleOwner);

            // Then
            expect(await readLockRecord(join(dataDir, 'sessions', `${sessionId}.lock`))).toMatchObject({
                ownerId: 'owner-reclaimer-during-close',
                heartbeatAt: '2026-06-12T10:00:00.000Z',
            });
        } finally {
            if (reclaimer !== undefined) {
                await closeOpenedFile(reclaimer);
            }
        }
    });

    it('fences stale file handles away from the active session log during recovery', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_lock_file_fence';
        const staleOwner = await openJsonlSessionFile({
            sessionId,
            dataDir,
            now: () => '2026-06-12T09:00:00.000Z',
            lockOwnerId: 'owner-stale-file-handle',
            lockStaleAfterMs: 30_000,
        });
        const reclaimer = await openJsonlSessionFile({
            sessionId,
            dataDir,
            now: () => '2026-06-12T10:00:00.000Z',
            lockOwnerId: 'owner-file-fence-reclaimer',
            lockStaleAfterMs: 30_000,
        });

        try {
            // When
            await staleOwner.fileHandle.writeFile('stale owner should not be authoritative\n', 'utf8');
            await reclaimer.fileHandle.writeFile('reclaimer remains authoritative\n', 'utf8');

            // Then
            const activeContents = await readFile(staleOwner.filePath, 'utf8');
            expect(activeContents).not.toContain('stale owner should not be authoritative');
            expect(activeContents).toContain('reclaimer remains authoritative');
        } finally {
            await closeOpenedFile(staleOwner);
            await closeOpenedFile(reclaimer);
        }
    });

    it('keeps a fresh heartbeat even when the lock was created long ago', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_lock_fresh_heartbeat';
        await writeLockRecord(dataDir, sessionId, {
            sessionId,
            ownerId: 'owner-fresh',
            createdAt: '2026-06-12T09:00:00.000Z',
            updatedAt: '2026-06-12T09:59:55.000Z',
            heartbeatAt: '2026-06-12T09:59:55.000Z',
        });

        // When
        const openLocked = openJsonlSessionFile({
            sessionId,
            dataDir,
            now: () => '2026-06-12T10:00:00.000Z',
            lockOwnerId: 'owner-second',
            lockStaleAfterMs: 30_000,
        });

        // Then
        await expect(openLocked).rejects.toMatchObject({ code: 'lock_exists', sessionId });
    });

    it('reclaims expired valid JSON lock metadata without an owner', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_lock_missing_owner';
        await writeLockRecord(dataDir, sessionId, {
            sessionId,
            createdAt: '2026-06-12T09:00:00.000Z',
            updatedAt: '2026-06-12T09:00:00.000Z',
        });

        // When
        const opened = await openJsonlSessionFile({
            sessionId,
            dataDir,
            now: () => '2026-06-12T10:00:00.000Z',
            lockOwnerId: 'owner-after-crash',
            lockStaleAfterMs: 30_000,
        });

        try {
            // Then
            expect(opened.lockRecovery?.previousLock).toMatchObject({
                sessionId,
                createdAt: '2026-06-12T09:00:00.000Z',
            });
            expect(await readLockRecord(opened.lockPath)).toMatchObject({
                ownerId: 'owner-after-crash',
                heartbeatAt: '2026-06-12T10:00:00.000Z',
            });
        } finally {
            await closeOpenedFile(opened);
        }
    });
});

async function createTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-jsonl-files-'));
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

async function closeOpenedFile(opened: OpenedJsonlSessionFile): Promise<void> {
    try {
        await opened.fileHandle.close();
    } finally {
        await releaseSessionLock(opened.lockHandle, opened.lockPath);
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
}
