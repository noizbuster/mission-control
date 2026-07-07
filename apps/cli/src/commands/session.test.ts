import {
    createFileSessionIndexStore,
    missionControlDataDirEnvKey,
    type SessionIndexSessionRecord,
} from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runSessionCommand } from './session.js';
import {
    diagnosticRecords,
    eventRecords,
    parseReplayRecords,
    sessionCommandFixtureEvents,
    taskCompletedEvent,
    writeSessionEvents,
} from './session-test-support.js';
import { appendFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

    it('lists stale locked sessions', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const staleSessionId = 'session_a_stale';
        const liveSessionId = 'session_z_live';
        await writeSessionEvents({
            dataDir,
            sessionId: staleSessionId,
            events: [taskCompletedEvent(staleSessionId, 'old session')],
        });
        await writeSessionEvents({
            dataDir,
            sessionId: liveSessionId,
            events: [taskCompletedEvent(liveSessionId, 'new session')],
        });
        const index = createFileSessionIndexStore({ indexPath: join(dataDir, 'session-index.json') });
        await index.replaceSessionIndex({
            sessionId: staleSessionId,
            records: [sessionIndexRecord(dataDir, staleSessionId, '2026-06-05T10:01:00.000Z')],
            diagnostics: [],
        });
        await index.replaceSessionIndex({
            sessionId: liveSessionId,
            records: [sessionIndexRecord(dataDir, liveSessionId, '2026-06-05T10:02:00.000Z')],
            diagnostics: [],
        });
        await writeSessionLock(dataDir, staleSessionId, '2026-06-05T09:00:00.000Z');
        await writeSessionLock(dataDir, liveSessionId, '2099-01-01T00:00:00.000Z');

        // When
        const listOutput = await runSessionCommand(parseArgs(['session', 'list']));

        // Then
        const lines = listOutput.trim().split('\n');
        expect(lines[0]).toContain(liveSessionId);
        expect(lines[0]).toContain('lock=live');
        expect(lines[0]).toContain('events=1');
        expect(lines[0]).toContain('updated=2026-06-05T10:02:00.000Z');
        expect(lines[1]).toContain(staleSessionId);
        expect(lines[1]).toContain('lock=stale');
        expect(lines[1]).toContain('updated=2026-06-05T10:01:00.000Z');
        await rm(dataDir, { recursive: true, force: true });
    });

    it('emits replay diagnostics for corrupt trailing JSONL without crashing', async () => {
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
        expect(eventRecords(replayRecords).map((event) => event.type)).toEqual([
            'session.started',
            'session.metadata.updated',
            'task.completed',
            'session.stopped',
        ]);
        expect(diagnosticRecords(replayRecords)).toEqual([
            {
                code: 'corrupt_trailing_record',
                lineNumber: events.length + 2,
                sessionId,
            },
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

function sessionIndexRecord(dataDir: string, sessionId: string, updatedAt: string): SessionIndexSessionRecord {
    return {
        kind: 'session',
        sessionId,
        status: 'stopped',
        startedAt: '2026-06-05T10:00:00.000Z',
        eventCount: 1,
        updatedAt,
        sourceFilePath: join(dataDir, 'sessions', `${sessionId}.jsonl`),
    };
}

async function writeSessionLock(dataDir: string, sessionId: string, heartbeatAt: string): Promise<void> {
    await writeFile(
        join(dataDir, 'sessions', `${sessionId}.lock`),
        `${JSON.stringify({
            sessionId,
            ownerId: `owner-${sessionId}`,
            createdAt: '2026-06-05T09:00:00.000Z',
            updatedAt: heartbeatAt,
            heartbeatAt,
        })}\n`,
        'utf8',
    );
}
