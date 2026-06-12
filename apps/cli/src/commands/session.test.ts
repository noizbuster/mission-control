import { missionControlDataDirEnvKey } from '@mission-control/core';
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
    providerFromPatchRequests,
    writeSessionEvents,
} from './session-test-support.js';
import { appendFile, mkdtemp, readFile, rm } from 'node:fs/promises';
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

        expect(listOutput.trim().split('\n')).toContain(sessionId);
        expect(JSON.parse(showOutput)).toMatchObject({
            sessionId,
            eventCount: runEvents.length,
            snapshot: {
                sessionId,
                status: 'stopped',
            },
        });
        expect(replayEvents.map((event) => event.type)).toEqual(runEvents.map((event) => event.type));
        await rm(dataDir, { recursive: true, force: true });
    });

    it('replays coding runs with provider, tool, result, and continuation records', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mission-control-cli-replay-workspace-'));
        const sessionId = 'session_cli_replay_coding';
        const runOutput = await runAgent(
            parseArgs(['run', 'patch then summarize', '--session', sessionId, '--jsonl']),
            {
                workspaceRoot,
                provider: providerFromPatchRequests(),
                nonInteractiveAutomationPolicy: 'test-only-allow-known-safe-patch',
            },
        );
        const runEvents = parseEventLines(runOutput);

        // When
        const replayOutput = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
        const replayRecords = parseReplayRecords(replayOutput);
        const showOutput = JSON.parse(await runSessionCommand(parseArgs(['session', 'show', sessionId])));

        // Then
        expect(eventRecords(replayRecords).map((event) => event.type)).toEqual(runEvents.map((event) => event.type));
        expect(codingStepRecords(replayRecords)).toEqual(
            expect.arrayContaining([
                expect.objectContaining({ kind: 'provider.tool_call', toolCallId: 'session_patch_call' }),
                expect.objectContaining({ kind: 'tool.result', status: 'completed' }),
                expect.objectContaining({
                    kind: 'provider.message',
                    continuation: true,
                    message: 'patch applied after replay',
                }),
            ]),
        );
        expect(showOutput).toMatchObject({
            sessionId,
            toolOutcomes: [
                expect.objectContaining({
                    toolId: 'session_patch_call',
                    status: 'completed',
                }),
            ],
            codingSteps: expect.arrayContaining([
                expect.objectContaining({ kind: 'provider.message', continuation: true }),
            ]),
            diagnostics: [],
        });
        expect(await readFile(join(workspaceRoot, '.mctrl-session-replay.txt'), 'utf8')).toBe('replayed\n');
        await rm(workspaceRoot, { recursive: true, force: true });
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
        expect(eventRecords(replayRecords).map((event) => event.type)).toEqual(runEvents.map((event) => event.type));
        expect(diagnosticRecords(replayRecords)).toEqual([
            {
                code: 'corrupt_trailing_record',
                lineNumber: runEvents.length + 2,
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

function parseEventLines(output: string) {
    return output
        .trim()
        .split('\n')
        .map((line) => AgentEventSchema.parse(JSON.parse(line)));
}
