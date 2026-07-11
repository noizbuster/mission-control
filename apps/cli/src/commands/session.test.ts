import { missionControlDataDirEnvKey } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runSessionCommand } from './session.js';
import {
    diagnosticRecords,
    eventRecords,
    parseReplayRecords,
    sessionCommandFixtureEvents,
    taskCompletedEvent,
    writeLocalSessionEvents,
    writeSessionEvents,
} from './session-test-support.js';
import { appendFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('session commands', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('lists shows and replays database sessions deterministically', async () => {
        const dataDir = await useTempDataDir();
        const sessionId = 'session_cli_commands';
        const events = sessionCommandFixtureEvents(sessionId, 'hello from session');
        await writeLocalSessionEvents({ dataDir, sessionId, events });

        const listOutput = await runSessionCommand(parseArgs(['session', 'list']));
        const showOutput = await runSessionCommand(parseArgs(['session', 'show', sessionId]));
        const replayOutput = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
        const replayEvents = eventRecords(parseReplayRecords(replayOutput));

        expect(
            [listOutput, showOutput, replayOutput].every(
                ({ stdout, stderr }) => !stdout.endsWith('\n') && stderr === '',
            ),
        ).toBe(true);
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
        expect(listOutput.stdout).toContain(firstSessionId);
        expect(listOutput.stdout).toContain(secondSessionId);
        expect(listOutput.stdout).toContain('events=1');
        expect(listOutput.stdout).not.toContain('lock=');
        await rm(dataDir, { recursive: true, force: true });
    });

    it('replays corrupt legacy JSONL as diagnostics after database import rejects it', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const sessionId = 'session_cli_replay_corrupt';
        const events = sessionCommandFixtureEvents(sessionId, 'hello before corruption');
        await writeSessionEvents({ dataDir, sessionId, events });
        await appendFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), '{"broken":\n', 'utf8');

        // When
        const replayOutput = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
        const replayRecords = parseReplayRecords(replayOutput);

        // Then
        expect(eventRecords(replayRecords)).toEqual([]);
        expect(diagnosticRecords(replayRecords)).toEqual([
            { code: 'corrupt_trailing_record', lineNumber: 6, sessionId },
        ]);
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
