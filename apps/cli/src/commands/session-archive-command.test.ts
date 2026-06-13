import { missionControlDataDirEnvKey, ProjectTrustStore } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runSessionCommand } from './session.js';
import {
    archiveManifest,
    createSessionLog,
    fixedNow,
    useTempDataDir,
    withProcessCwd,
} from './session-import-export-fixtures.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('session archive commands', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('exports and imports a deterministic session archive without changing replay projection', async () => {
        const sourceDataDir = await useTempDataDir();
        const importDataDir = await mkdtemp(join(tmpdir(), 'mission-control-session-import-data-'));
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mission-control-session-import-workspace-'));
        const sessionId = 'session_export_roundtrip';
        const archivePath = join(tmpdir(), 'session_export_roundtrip.mctrl-session.json');
        await mkdir(join(importDataDir, 'sessions'), { recursive: true });
        await new ProjectTrustStore({ dataDir: sourceDataDir, now: fixedNow }).setDecision(workspaceRoot, 'trusted');
        await new ProjectTrustStore({ dataDir: importDataDir, now: fixedNow }).setDecision(workspaceRoot, 'trusted');
        await writeFile(
            join(sourceDataDir, 'sessions', `${sessionId}.jsonl`),
            createSessionLog({
                sessionId,
                createdAt: '2026-06-13T11:00:00.000Z',
                updatedAt: '2026-06-13T11:00:03.000Z',
                cwd: workspaceRoot,
                workspaceTrust: 'trusted',
                name: 'Export demo',
                parentSessionId: 'session_seed',
                activeLeafId: 'entry_reply',
            }),
            'utf8',
        );
        const originalShow = await withProcessCwd(workspaceRoot, async () => {
            vi.stubEnv(missionControlDataDirEnvKey, sourceDataDir);
            return runSessionCommand(parseArgs(['session', 'show', sessionId]));
        });

        await withProcessCwd(workspaceRoot, async () => {
            vi.stubEnv(missionControlDataDirEnvKey, sourceDataDir);
            await runSessionCommand(parseArgs(['session', 'export', sessionId, archivePath]));
        });
        await withProcessCwd(workspaceRoot, async () => {
            vi.stubEnv(missionControlDataDirEnvKey, importDataDir);
            await runSessionCommand(parseArgs(['session', 'import', archivePath]));
        });
        const importedShow = await withProcessCwd(workspaceRoot, async () => {
            vi.stubEnv(missionControlDataDirEnvKey, importDataDir);
            return runSessionCommand(parseArgs(['session', 'show', sessionId]));
        });

        expect(JSON.parse(await readFile(archivePath, 'utf8'))).toMatchObject({
            kind: 'mission-control.session-archive',
            version: 1,
            manifest: { sessionId, cwd: workspaceRoot, trustedRoot: workspaceRoot },
        });
        expect(JSON.parse(importedShow)).toMatchObject({
            ...JSON.parse(originalShow),
            indexed: true,
            indexState: 'derived',
        });
        await rm(archivePath, { force: true });
        await rm(sourceDataDir, { recursive: true, force: true });
        await rm(importDataDir, { recursive: true, force: true });
        await rm(workspaceRoot, { recursive: true, force: true });
    });

    it('rejects corrupt archives session mismatches invalid schema untrusted cwd and collisions', async () => {
        const dataDir = await useTempDataDir();
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mission-control-session-reject-workspace-'));
        const sessionId = 'session_import_reject';
        const corruptArchivePath = join(tmpdir(), 'session-import-corrupt.mctrl-session.json');
        const mismatchArchivePath = join(tmpdir(), 'session-import-mismatch.mctrl-session.json');
        const invalidArchivePath = join(tmpdir(), 'session-import-invalid.mctrl-session.json');
        const trustedArchivePath = join(tmpdir(), 'session-import-trusted.mctrl-session.json');
        await new ProjectTrustStore({ dataDir, now: fixedNow }).setDecision(workspaceRoot, 'trusted');
        await writeFile(
            corruptArchivePath,
            JSON.stringify({
                kind: 'mission-control.session-archive',
                version: 1,
                manifest: archiveManifest(sessionId, workspaceRoot),
                checksum: { algorithm: 'sha256', value: 'deadbeef' },
                eventsJsonl: '{"broken":',
            }),
            'utf8',
        );
        await writeFile(
            mismatchArchivePath,
            JSON.stringify({
                kind: 'mission-control.session-archive',
                version: 1,
                manifest: archiveManifest(sessionId, workspaceRoot),
                checksum: { algorithm: 'sha256', value: 'skip' },
                eventsJsonl: createSessionLog({
                    sessionId: 'session_other',
                    createdAt: '2026-06-13T12:00:00.000Z',
                    updatedAt: '2026-06-13T12:00:03.000Z',
                    cwd: workspaceRoot,
                    workspaceTrust: 'trusted',
                    name: 'Mismatch demo',
                    activeLeafId: 'entry_root',
                }),
            }),
            'utf8',
        );
        await writeFile(
            invalidArchivePath,
            JSON.stringify({
                kind: 'mission-control.session-archive',
                version: 99,
                manifest: archiveManifest(sessionId, workspaceRoot),
                checksum: { algorithm: 'sha256', value: 'skip' },
                eventsJsonl: createSessionLog({
                    sessionId,
                    createdAt: '2026-06-13T12:00:00.000Z',
                    updatedAt: '2026-06-13T12:00:03.000Z',
                    cwd: workspaceRoot,
                    workspaceTrust: 'trusted',
                    name: 'Invalid demo',
                    activeLeafId: 'entry_root',
                }),
            }),
            'utf8',
        );
        await writeFile(
            trustedArchivePath,
            JSON.stringify({
                kind: 'mission-control.session-archive',
                version: 1,
                manifest: archiveManifest(sessionId, workspaceRoot),
                checksum: { algorithm: 'sha256', value: 'skip' },
                eventsJsonl: createSessionLog({
                    sessionId,
                    createdAt: '2026-06-13T12:00:00.000Z',
                    updatedAt: '2026-06-13T12:00:03.000Z',
                    cwd: workspaceRoot,
                    workspaceTrust: 'trusted',
                    name: 'Trusted demo',
                    activeLeafId: 'entry_root',
                }),
            }),
            'utf8',
        );
        await writeFile(
            join(dataDir, 'sessions', `${sessionId}.jsonl`),
            createSessionLog({
                sessionId,
                createdAt: '2026-06-13T12:30:00.000Z',
                updatedAt: '2026-06-13T12:30:03.000Z',
                cwd: workspaceRoot,
                workspaceTrust: 'trusted',
                name: 'Existing session',
                activeLeafId: 'entry_root',
            }),
            'utf8',
        );

        await expect(
            withProcessCwd(workspaceRoot, async () => {
                vi.stubEnv(missionControlDataDirEnvKey, dataDir);
                return runSessionCommand(parseArgs(['session', 'import', corruptArchivePath]));
            }),
        ).rejects.toThrow();
        await expect(
            withProcessCwd(workspaceRoot, async () => {
                vi.stubEnv(missionControlDataDirEnvKey, dataDir);
                return runSessionCommand(parseArgs(['session', 'import', mismatchArchivePath]));
            }),
        ).rejects.toThrow();
        await expect(
            withProcessCwd(workspaceRoot, async () => {
                vi.stubEnv(missionControlDataDirEnvKey, dataDir);
                return runSessionCommand(parseArgs(['session', 'import', invalidArchivePath]));
            }),
        ).rejects.toThrow();
        await expect(
            withProcessCwd(await mkdtemp(join(tmpdir(), 'mission-control-untrusted-workspace-')), async () => {
                vi.stubEnv(missionControlDataDirEnvKey, dataDir);
                return runSessionCommand(parseArgs(['session', 'import', trustedArchivePath]));
            }),
        ).rejects.toThrow();
        await expect(
            withProcessCwd(workspaceRoot, async () => {
                vi.stubEnv(missionControlDataDirEnvKey, dataDir);
                return runSessionCommand(parseArgs(['session', 'import', trustedArchivePath]));
            }),
        ).rejects.toThrow();
        expect(await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8')).toContain('Existing session');
        await rm(corruptArchivePath, { force: true });
        await rm(mismatchArchivePath, { force: true });
        await rm(invalidArchivePath, { force: true });
        await rm(trustedArchivePath, { force: true });
        await rm(workspaceRoot, { recursive: true, force: true });
        await rm(dataDir, { recursive: true, force: true });
    });
});
