import { missionControlDataDirEnvKey } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runSessionCommand } from './session.js';
import {
    eventRecords,
    parseReplayRecords,
    sessionCommandFixtureEvents,
    taskCompletedEvent,
    writeSessionEvents,
} from './session-test-support.js';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('session commands', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('lists shows and replays JSONL session logs deterministically', async () => {
        const dataDir = await useTempDataDir();
        const sessionId = 'session_cli_commands';
        const events = sessionCommandFixtureEvents(sessionId, 'hello from session');
        await writeSessionEvents({ dataDir, sessionId, events });

        const listOutput = await runSessionCommand(parseArgs(['session', 'list']));
        const showOutput = await runSessionCommand(parseArgs(['session', 'show', sessionId]));
        const replayOutput = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
        const replayEvents = eventRecords(parseReplayRecords(replayOutput));

        expect(listOutput.trim().split('\n')).toEqual(
            expect.arrayContaining([expect.stringMatching(new RegExp(`^${sessionId}\\t`))]),
        );
        expect(JSON.parse(showOutput)).toMatchObject({
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
        await rm(dataDir, { recursive: true, force: true });
    });

    it('lists imported sessions without file lock metadata', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const firstSessionId = 'session_a_imported';
        const secondSessionId = 'session_z_imported';
        await writeSessionEvents({
            dataDir,
            sessionId: firstSessionId,
            events: [taskCompletedEvent(firstSessionId, 'first session')],
        });
        await writeSessionEvents({
            dataDir,
            sessionId: secondSessionId,
            events: [taskCompletedEvent(secondSessionId, 'second session')],
        });

        // When
        const listOutput = await runSessionCommand(parseArgs(['session', 'list']));

        // Then
        expect(listOutput).toContain(firstSessionId);
        expect(listOutput).toContain(secondSessionId);
        expect(listOutput).toContain('events=1');
        expect(listOutput).not.toContain('lock=');
        await rm(dataDir, { recursive: true, force: true });
    });

    it('does not replay corrupt legacy JSONL after database import rejects it', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const sessionId = 'session_cli_replay_corrupt';
        const events = sessionCommandFixtureEvents(sessionId, 'hello before corruption');
        await writeSessionEvents({ dataDir, sessionId, events });
        await appendFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), '{"broken":\n', 'utf8');

        // When / Then
        await expect(runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']))).rejects.toMatchObject({
            code: 'session_not_found',
            sessionId,
        });
        await rm(dataDir, { recursive: true, force: true });
    });

    it('throws typed errors for invalid session ids and missing logs', async () => {
        const dataDir = await useTempDataDir();

        await expect(runSessionCommand(parseArgs(['session', 'show', '../bad']))).rejects.toMatchObject({
            code: 'invalid_session_id',
        });
        await expect(runSessionCommand(parseArgs(['session', 'show', 'session_missing']))).rejects.toMatchObject({
            code: 'session_not_found',
        });
        await rm(dataDir, { recursive: true, force: true });
    });
});

async function useTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-cli-session-'));
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return dataDir;
}
