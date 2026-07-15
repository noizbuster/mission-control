import { localSessionDbPath, missionControlDataDirEnvKey } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { runSessionCommand } from './session';
import {
    eventRecords,
    parseReplayRecords,
    sessionCommandFixtureEvents,
    writeLocalSessionEvents,
} from './session-test-support';
import { access, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('SQLite-native session commands', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('lists shows replays and exports sessions without a legacy JSONL log', async () => {
        const dataDir = await useTempDataDir();
        const sessionId = 'session_cli_sqlite_native';
        const events = sessionCommandFixtureEvents(sessionId, 'hello from sqlite');
        await writeLocalSessionEvents({ dataDir, sessionId, events });

        const listOutput = await runSessionCommand(parseArgs(['session', 'list']));
        const showOutput = await runSessionCommand(parseArgs(['session', 'show', sessionId]));
        const replayOutput = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
        const archivePath = join(dataDir, 'exports', 'sqlite-native.mctrl-session.json');
        const exportOutput = await runSessionCommand(parseArgs(['session', 'export', sessionId, archivePath]));
        const replayEvents = eventRecords(parseReplayRecords(replayOutput));
        const archive = JSON.parse(await readFile(archivePath, 'utf8'));

        expect(listOutput.stdout.trim().split('\n')).toEqual(
            expect.arrayContaining([expect.stringMatching(new RegExp(`^${sessionId}\\t`))]),
        );
        expect(JSON.parse(showOutput.stdout)).toMatchObject({
            sessionId,
            eventCount: replayEvents.length,
            statusText: 'stopped',
            snapshot: {
                sessionId,
                status: 'stopped',
            },
        });
        expect(replayEvents.map((event) => event.type)).toEqual([
            'session.started',
            'session.metadata.updated',
            'task.completed',
            'session.stopped',
        ]);
        expect(exportOutput.stdout).toContain(`Exported session ${sessionId}`);
        expect(archive.manifest.sessionId).toBe(sessionId);
        expect(archive.eventsJsonl).toContain('"kind":"mission-control.session-event"');
        await expect(access(localSessionDbPath(dataDir))).resolves.toBeUndefined();
        await expect(readdir(join(dataDir, 'sessions'))).rejects.toMatchObject({ code: 'ENOENT' });
        await rm(dataDir, { recursive: true, force: true });
    });
});

async function useTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-cli-session-sqlite-'));
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return dataDir;
}
