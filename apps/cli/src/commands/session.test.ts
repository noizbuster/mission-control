import {
    createFileSessionIndexStore,
    missionControlDataDirEnvKey,
    type SessionIndexSessionRecord,
} from '@mission-control/core';
import { type AgentEvent, AgentEventSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import { runSessionCommand } from './session.js';
import {
    codingStepRecords,
    diagnosticRecords,
    eventRecords,
    parseReplayRecords,
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
        const runOutput = await runAgent(parseArgs(['run', 'hello from session', '--session', sessionId, '--jsonl']));
        const runEvents = parseEventLines(runOutput);

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
            snapshot: {
                sessionId,
                status: 'stopped',
            },
        });
        expect(replayEvents.map((event) => event.type)).toEqual([
            'session.started',
            'session.metadata.updated',
            ...runEvents.filter((event) => event.type !== 'session.started').map((event) => event.type),
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
        const runOutput = await runAgent(
            parseArgs(['run', 'hello before corruption', '--session', sessionId, '--jsonl']),
        );
        const runEvents = parseEventLines(runOutput);
        await appendFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), '{"broken":\n', 'utf8');

        // When
        const replayOutput = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
        const replayRecords = parseReplayRecords(replayOutput);

        // Then
        expect(eventRecords(replayRecords).map((event) => event.type)).toEqual([
            'session.started',
            'session.metadata.updated',
            ...runEvents.filter((event) => event.type !== 'session.started').map((event) => event.type),
        ]);
        expect(diagnosticRecords(replayRecords)).toEqual([
            {
                code: 'corrupt_trailing_record',
                lineNumber: runEvents.length + 3,
                sessionId,
            },
        ]);
        await rm(dataDir, { recursive: true, force: true });
    });

    it('renders failed run state', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const sessionId = 'session_cli_run_failed';
        await writeSessionEvents({
            dataDir,
            sessionId,
            events: [
                runEvent(sessionId, 'run.started', 'run started', {
                    command: 'run',
                    state: 'running',
                    runId: 'run_failed',
                }),
                runEvent(sessionId, 'run.failed', 'provider exploded', {
                    command: 'run',
                    state: 'failed',
                    runId: 'run_failed',
                    reason: 'provider exploded',
                    errorCode: 'unknown',
                }),
            ],
        });

        // When
        const showOutput = JSON.parse(await runSessionCommand(parseArgs(['session', 'show', sessionId])));
        const replayRecords = parseReplayRecords(
            await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl'])),
        );

        // Then
        expect(showOutput.codingSteps).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'run.state', state: 'failed', reason: 'provider exploded' }),
            ]),
        );
        expect(codingStepRecords(replayRecords)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'run.state', state: 'failed', errorCode: 'unknown' }),
            ]),
        );
        await rm(dataDir, { recursive: true, force: true });
    });

    it('renders blocked run state distinctly', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const sessionId = 'session_cli_run_blocked';
        await writeSessionEvents({
            dataDir,
            sessionId,
            events: [
                runEvent(sessionId, 'run.started', 'run started', {
                    command: 'run',
                    state: 'running',
                    runId: 'run_blocked',
                }),
                runEvent(sessionId, 'run.blocked', 'waiting for approval: file.patch', {
                    command: 'run',
                    state: 'blocked_on_approval',
                    runId: 'run_blocked',
                    reason: 'waiting for approval: file.patch',
                    errorCode: 'tool_failed',
                    toolCallId: 'patch_call',
                }),
            ],
        });

        // When
        const showOutput = JSON.parse(await runSessionCommand(parseArgs(['session', 'show', sessionId])));
        const replayRecords = parseReplayRecords(
            await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl'])),
        );

        // Then
        expect(showOutput.codingSteps).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'run.state',
                    state: 'blocked_on_approval',
                    toolCallId: 'patch_call',
                }),
            ]),
        );
        expect(codingStepRecords(replayRecords)).toEqual(
            expect.arrayContaining([expect.objectContaining({ kind: 'run.state', state: 'blocked_on_approval' })]),
        );
        await rm(dataDir, { recursive: true, force: true });
    });

    it('renders interrupted run state distinctly', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const sessionId = 'session_cli_run_interrupted';
        await writeSessionEvents({
            dataDir,
            sessionId,
            events: [
                runEvent(sessionId, 'run.started', 'run started', {
                    command: 'run',
                    state: 'running',
                    runId: 'run_interrupted',
                }),
                runEvent(sessionId, 'run.interrupted', 'run interrupted', {
                    command: 'run',
                    state: 'interrupted',
                    runId: 'run_interrupted',
                }),
            ],
        });

        // When
        const replayRecords = parseReplayRecords(
            await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl'])),
        );

        // Then
        expect(codingStepRecords(replayRecords)).toEqual(
            expect.arrayContaining([expect.objectContaining({ kind: 'run.state', state: 'interrupted' })]),
        );
        expect(eventRecords(replayRecords).map((event) => event.type)).toEqual(
            expect.arrayContaining(['run.started', 'run.interrupted']),
        );
        await rm(dataDir, { recursive: true, force: true });
    });

    it('replay preserves completed, failed, interrupted, and blocked terminal run events distinctly', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const scenarios = [
            {
                sessionId: 'session_cli_run_completed',
                eventType: 'run.completed',
                state: 'completed',
                message: 'run completed',
            },
            {
                sessionId: 'session_cli_run_failed_replay',
                eventType: 'run.failed',
                state: 'failed',
                message: 'run failed',
            },
            {
                sessionId: 'session_cli_run_interrupted_replay',
                eventType: 'run.interrupted',
                state: 'interrupted',
                message: 'run interrupted',
            },
            {
                sessionId: 'session_cli_run_blocked_replay',
                eventType: 'run.blocked',
                state: 'blocked_on_approval',
                message: 'waiting for approval: file.patch',
            },
        ] as const;

        for (const scenario of scenarios) {
            await writeSessionEvents({
                dataDir,
                sessionId: scenario.sessionId,
                events: [
                    runEvent(scenario.sessionId, 'run.started', 'run started', {
                        command: 'run',
                        state: 'running',
                        runId: `${scenario.sessionId}_run`,
                    }),
                    runEvent(scenario.sessionId, scenario.eventType, scenario.message, {
                        command: 'run',
                        state: scenario.state,
                        runId: `${scenario.sessionId}_run`,
                        ...(scenario.state === 'failed'
                            ? { reason: scenario.message, errorCode: 'unknown' as const }
                            : {}),
                        ...(scenario.state === 'blocked_on_approval'
                            ? { reason: scenario.message, errorCode: 'tool_failed' as const, toolCallId: 'patch_call' }
                            : {}),
                    }),
                ],
            });
        }

        for (const scenario of scenarios) {
            const replayRecords = parseReplayRecords(
                await runSessionCommand(parseArgs(['session', 'replay', scenario.sessionId, '--jsonl'])),
            );
            expect(eventRecords(replayRecords).map((event) => event.type)).toEqual(
                expect.arrayContaining(['run.started', scenario.eventType]),
            );
            expect(codingStepRecords(replayRecords)).toEqual(
                expect.arrayContaining([expect.objectContaining({ kind: 'run.state', state: scenario.state })]),
            );
        }

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

function runEvent(sessionId: string, type: AgentEvent['type'], message: string, run: NonNullable<AgentEvent['run']>) {
    return {
        type,
        timestamp: '2026-06-05T10:00:00.000Z',
        sessionId,
        message,
        run,
    };
}

function taskCompletedEvent(sessionId: string, message: string): AgentEvent {
    return {
        type: 'task.completed',
        timestamp: '2026-06-05T10:00:00.000Z',
        sessionId,
        message,
    };
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

function parseEventLines(output: string) {
    return output
        .trim()
        .split('\n')
        .map((line) => AgentEventSchema.parse(JSON.parse(line)));
}
