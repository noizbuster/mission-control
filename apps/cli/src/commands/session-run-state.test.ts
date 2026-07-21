import { missionControlDataDirEnvKey } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { runSessionCommand } from './session';
import { codingStepRecords, eventRecords, parseReplayRecords, writeLocalSessionEvents } from './session-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type RunStateScenario = {
    readonly sessionId: string;
    readonly eventType: AgentEvent['type'];
    readonly state: NonNullable<AgentEvent['run']>['state'];
    readonly message: string;
};

type RunEventInput = {
    readonly sessionId: string;
    readonly type: AgentEvent['type'];
    readonly message: string;
    readonly run: NonNullable<AgentEvent['run']>;
};

describe('session run-state rendering', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('renders failed run state', async () => {
        // Given
        const dataDir = await useTempDataDir();
        const sessionId = 'session_cli_run_failed';
        await writeLocalSessionEvents({
            dataDir,
            sessionId,
            events: [
                runEvent({
                    sessionId,
                    type: 'run.started',
                    message: 'run started',
                    run: { command: 'run', state: 'running', runId: 'run_failed' },
                }),
                runEvent({
                    sessionId,
                    type: 'run.failed',
                    message: 'provider exploded',
                    run: {
                        command: 'run',
                        state: 'failed',
                        runId: 'run_failed',
                        reason: 'provider exploded',
                        errorCode: 'unknown',
                    },
                }),
            ],
        });

        // When
        const showOutput = JSON.parse((await runSessionCommand(parseArgs(['session', 'show', sessionId]))).stdout);
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
        await writeLocalSessionEvents({
            dataDir,
            sessionId,
            events: [
                runEvent({
                    sessionId,
                    type: 'run.started',
                    message: 'run started',
                    run: { command: 'run', state: 'running', runId: 'run_blocked' },
                }),
                runEvent({
                    sessionId,
                    type: 'run.blocked',
                    message: 'waiting for approval: file.patch',
                    run: {
                        command: 'run',
                        state: 'blocked_on_approval',
                        runId: 'run_blocked',
                        reason: 'waiting for approval: file.patch',
                        errorCode: 'tool_failed',
                        toolCallId: 'patch_call',
                    },
                }),
            ],
        });

        // When
        const showOutput = JSON.parse((await runSessionCommand(parseArgs(['session', 'show', sessionId]))).stdout);
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
        await writeLocalSessionEvents({
            dataDir,
            sessionId,
            events: [
                runEvent({
                    sessionId,
                    type: 'run.started',
                    message: 'run started',
                    run: { command: 'run', state: 'running', runId: 'run_interrupted' },
                }),
                runEvent({
                    sessionId,
                    type: 'run.interrupted',
                    message: 'run interrupted',
                    run: { command: 'run', state: 'interrupted', runId: 'run_interrupted' },
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
        const scenarios: readonly RunStateScenario[] = [
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
        ];

        for (const scenario of scenarios) {
            await writeLocalSessionEvents({
                dataDir,
                sessionId: scenario.sessionId,
                events: [
                    runEvent({
                        sessionId: scenario.sessionId,
                        type: 'run.started',
                        message: 'run started',
                        run: { command: 'run', state: 'running', runId: `${scenario.sessionId}_run` },
                    }),
                    runEvent({
                        sessionId: scenario.sessionId,
                        type: scenario.eventType,
                        message: scenario.message,
                        run: terminalRunPayload(scenario),
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
});

async function useTempDataDir(): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-cli-session-run-state-'));
    vi.stubEnv(missionControlDataDirEnvKey, dataDir);
    return dataDir;
}

function runEvent(input: RunEventInput): AgentEvent {
    return {
        type: input.type,
        timestamp: '2026-06-05T10:00:00.000Z',
        sessionId: input.sessionId,
        message: input.message,
        run: input.run,
    };
}

function terminalRunPayload(scenario: RunStateScenario): NonNullable<AgentEvent['run']> {
    switch (scenario.state) {
        case 'failed':
            return {
                command: 'run',
                state: scenario.state,
                runId: `${scenario.sessionId}_run`,
                reason: scenario.message,
                errorCode: 'unknown',
            };
        case 'blocked_on_approval':
            return {
                command: 'run',
                state: scenario.state,
                runId: `${scenario.sessionId}_run`,
                reason: scenario.message,
                errorCode: 'tool_failed',
                toolCallId: 'patch_call',
            };
        default:
            return { command: 'run', state: scenario.state, runId: `${scenario.sessionId}_run` };
    }
}
