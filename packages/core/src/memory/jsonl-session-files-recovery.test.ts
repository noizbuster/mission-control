import { afterEach, describe, expect, it } from 'vitest';
import { openJsonlSessionFile, releaseSessionLock } from './jsonl-session-files.js';
import { createJsonlSessionLogHeader, serializeJsonlRecord } from './jsonl-session-records.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

afterEach(async () => {
    for (const tempDir of tempDirs.splice(0)) {
        await rm(tempDir, { recursive: true, force: true });
    }
});

describe('JSONL session file recovery', () => {
    it('restores an orphaned recovered log before creating a fresh header', async () => {
        // Given
        const dataDir = await createTempDataDir();
        const sessionId = 'session_orphaned_recovered_log';
        const sessionsDir = join(dataDir, 'sessions');
        const filePath = join(sessionsDir, `${sessionId}.jsonl`);
        const backupPath = `${filePath}.recovered-crash`;
        const originalHeader = serializeJsonlRecord(
            createJsonlSessionLogHeader({
                sessionId,
                createdAt: '2026-06-12T09:00:00.000Z',
            }),
        );
        await mkdir(sessionsDir, { recursive: true });
        await writeFile(backupPath, originalHeader, 'utf8');

        // When
        const opened = await openJsonlSessionFile({
            sessionId,
            dataDir,
            now: () => '2026-06-12T10:00:00.000Z',
        });

        try {
            // Then
            expect(await readFile(filePath, 'utf8')).toBe(originalHeader);
            await expect(readFile(backupPath, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        } finally {
            await opened.fileHandle.close();
            await releaseSessionLock(opened.lockHandle, opened.lockPath);
        }
    });
});

async function createTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-jsonl-file-recovery-'));
    tempDirs.push(dataDir);
    return dataDir;
}
