import { missionControlDataDirEnvKey, ProjectTrustStore } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { createProviderAuthStore } from '../auth-store';
import { runSessionCommand } from './session';
import {
    createArchiveJson,
    createSessionLog,
    fixedNow,
    useTempDataDir,
    withProcessCwd,
} from './session-import-export-fixtures';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('session archive credential redaction', () => {
    afterEach(() => vi.unstubAllEnvs());

    it('redacts configured credentials while exporting and importing archive event logs', async () => {
        const dataDir = await useTempDataDir();
        const scratch = await mkdtemp(join(tmpdir(), 'mission-control-session-archive-redaction-'));
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mission-control-session-archive-workspace-'));
        const exportedSessionId = 'session_archive_redaction_export';
        const importedSessionId = 'session_archive_redaction_import';
        const exportPath = join(scratch, 'export.mctrl-session.json');
        const importPath = join(scratch, 'import.mctrl-session.json');
        const credential = ['archive', 'configured', 'credential'].join('_');
        await createProviderAuthStore().saveCredential({
            providerID: 'local',
            modelID: 'local-echo',
            apiKey: credential,
            now: '2026-06-13T09:00:00.000Z',
        });
        await new ProjectTrustStore({ dataDir, now: fixedNow }).setDecision(workspaceRoot, 'trusted');
        const sourceLog = createSessionLog({
            sessionId: exportedSessionId,
            createdAt: '2026-06-13T11:00:00.000Z',
            updatedAt: '2026-06-13T11:00:03.000Z',
            cwd: workspaceRoot,
            workspaceTrust: 'trusted',
            name: `Export ${credential}`,
            activeLeafId: 'entry_reply',
        });
        const importedLog = createSessionLog({
            sessionId: importedSessionId,
            createdAt: '2026-06-13T12:00:00.000Z',
            updatedAt: '2026-06-13T12:00:03.000Z',
            cwd: workspaceRoot,
            workspaceTrust: 'trusted',
            name: `Import ${credential}`,
            activeLeafId: 'entry_reply',
        });
        await writeFile(join(dataDir, 'sessions', `${exportedSessionId}.jsonl`), sourceLog, 'utf8');
        await writeFile(
            importPath,
            createArchiveJson({ sessionId: importedSessionId, workspaceRoot, eventsJsonl: importedLog }),
            'utf8',
        );

        await withProcessCwd(workspaceRoot, async () => {
            vi.stubEnv(missionControlDataDirEnvKey, dataDir);
            await runSessionCommand(parseArgs(['session', 'export', exportedSessionId, exportPath]));
            await runSessionCommand(parseArgs(['session', 'import', importPath]));
        });

        const observable = [
            await readFile(exportPath, 'utf8'),
            await readFile(join(dataDir, 'sessions', `${importedSessionId}.jsonl`), 'utf8'),
        ].join('\n');
        expect(observable).toContain('[REDACTED_CREDENTIAL]');
        expect(observable).not.toContain(credential);
        await Promise.all([
            rm(scratch, { recursive: true, force: true }),
            rm(workspaceRoot, { recursive: true, force: true }),
            rm(dataDir, { recursive: true, force: true }),
        ]);
    });
});
