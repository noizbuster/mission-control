import { missionControlDataDirEnvKey, ProjectTrustStore } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runSessionCommand } from './session.js';
import {
    createArchiveJson,
    createSessionLog,
    fixedNow,
    useTempDataDir,
    withProcessCwd,
} from './session-import-export-fixtures.js';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('session archive security repairs', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('rejects invalid imported session ids before a session log path can escape the sessions directory', async () => {
        const dataDir = await useTempDataDir();
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mission-control-session-traversal-workspace-'));
        const archivePath = join(tmpdir(), 'session-import-traversal.mctrl-session.json');
        const maliciousSessionId = '../escape_attempt';
        await new ProjectTrustStore({ dataDir, now: fixedNow }).setDecision(workspaceRoot, 'trusted');
        await writeFile(
            archivePath,
            createArchiveJson({
                sessionId: maliciousSessionId,
                workspaceRoot,
                eventsJsonl: createSessionLog({
                    sessionId: maliciousSessionId,
                    createdAt: '2026-06-13T12:00:00.000Z',
                    updatedAt: '2026-06-13T12:00:03.000Z',
                    cwd: workspaceRoot,
                    workspaceTrust: 'trusted',
                    name: 'Traversal demo',
                    activeLeafId: 'entry_root',
                }),
            }),
            'utf8',
        );

        await expect(
            withProcessCwd(workspaceRoot, async () => {
                vi.stubEnv(missionControlDataDirEnvKey, dataDir);
                return runSessionCommand(parseArgs(['session', 'import', archivePath]));
            }),
        ).rejects.toThrow();
        await expect(stat(join(dataDir, 'escape_attempt.jsonl'))).rejects.toThrow();
        await expect(stat(join(dataDir, 'sessions', '..', 'escape_attempt.jsonl'))).rejects.toThrow();
        await rm(archivePath, { force: true });
        await rm(workspaceRoot, { recursive: true, force: true });
        await rm(dataDir, { recursive: true, force: true });
    });

    it('does not overwrite an existing export destination', async () => {
        const dataDir = await useTempDataDir();
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mission-control-session-export-workspace-'));
        const sessionId = 'session_export_existing_archive';
        const archivePath = join(tmpdir(), 'session-export-existing.mctrl-session.json');
        await new ProjectTrustStore({ dataDir, now: fixedNow }).setDecision(workspaceRoot, 'trusted');
        await writeFile(
            join(dataDir, 'sessions', `${sessionId}.jsonl`),
            createSessionLog({
                sessionId,
                createdAt: '2026-06-13T11:00:00.000Z',
                updatedAt: '2026-06-13T11:00:03.000Z',
                cwd: workspaceRoot,
                workspaceTrust: 'trusted',
                name: 'Existing archive demo',
                activeLeafId: 'entry_reply',
            }),
            'utf8',
        );
        await writeFile(archivePath, 'keep me', 'utf8');

        await expect(
            withProcessCwd(workspaceRoot, async () => {
                vi.stubEnv(missionControlDataDirEnvKey, dataDir);
                return runSessionCommand(parseArgs(['session', 'export', sessionId, archivePath]));
            }),
        ).rejects.toThrow();
        await expect(readFile(archivePath, 'utf8')).resolves.toBe('keep me');
        await rm(archivePath, { force: true });
        await rm(workspaceRoot, { recursive: true, force: true });
        await rm(dataDir, { recursive: true, force: true });
    });
});
