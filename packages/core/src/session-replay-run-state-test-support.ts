import { expect } from 'vitest';
import { projectSessionReplay } from './session-replay.js';
import { approvalEvent, envelope, runEvent } from './session-replay-coding-test-support.js';

export function expectBlockedApprovalAndResumedRunProjection(): void {
    const sessionId = 'session_replay_run_blocked_resumed';
    const replay = projectSessionReplay({
        sessionId,
        envelopes: [
            envelope(
                runEvent(sessionId, 'run.command.received', 'queue prompt', {
                    command: 'queue',
                    state: 'idle',
                    inputId: 'input_queue',
                    messageId: 'message_queue',
                    delivery: 'queue',
                }),
                0,
                'event_queue_command',
            ),
            envelope(
                runEvent(sessionId, 'run.command.received', 'steer prompt', {
                    command: 'steer',
                    state: 'running',
                    inputId: 'input_steer',
                    messageId: 'message_steer',
                    delivery: 'steer',
                }),
                1,
                'event_steer_command',
            ),
            envelope(
                runEvent(sessionId, 'run.started', 'run started', {
                    command: 'run',
                    state: 'running',
                    runId: 'run_1',
                }),
                2,
                'event_run_started',
            ),
            envelope(approvalEvent(sessionId, 'approval.requested', 'pending'), 3, 'event_approval_requested'),
            envelope(
                runEvent(sessionId, 'run.blocked', 'waiting for approval: file.patch', {
                    command: 'run',
                    state: 'blocked_on_approval',
                    runId: 'run_1',
                    reason: 'waiting for approval: file.patch',
                    errorCode: 'tool_failed',
                    toolCallId: 'patch_call',
                }),
                4,
                'event_run_blocked',
            ),
            envelope(approvalEvent(sessionId, 'approval.updated', 'approved'), 5, 'event_approval_updated'),
            envelope(
                runEvent(sessionId, 'run.command.received', 'run command: resume', {
                    command: 'resume',
                    state: 'idle',
                    runId: 'run_2',
                }),
                6,
                'event_resume_command',
            ),
            envelope(
                runEvent(sessionId, 'run.started', 'run resumed', {
                    command: 'resume',
                    state: 'running',
                    runId: 'run_2',
                }),
                7,
                'event_resume_started',
            ),
            envelope(
                runEvent(sessionId, 'run.completed', 'run completed', {
                    command: 'resume',
                    state: 'completed',
                    runId: 'run_2',
                }),
                8,
                'event_resume_completed',
            ),
        ],
    });

    expect(stepsWithKind(replay.codingSteps, 'run.state')).toEqual([
        expect.objectContaining({ eventId: 'event_queue_command', command: 'queue', state: 'idle' }),
        expect.objectContaining({ eventId: 'event_steer_command', command: 'steer', state: 'running' }),
        expect.objectContaining({ eventId: 'event_run_started', command: 'run', state: 'running' }),
        expect.objectContaining({
            eventId: 'event_run_blocked',
            command: 'run',
            state: 'blocked_on_approval',
            toolCallId: 'patch_call',
        }),
        expect.objectContaining({ eventId: 'event_resume_command', command: 'resume', state: 'idle' }),
        expect.objectContaining({ eventId: 'event_resume_started', command: 'resume', state: 'running' }),
        expect.objectContaining({ eventId: 'event_resume_completed', command: 'resume', state: 'completed' }),
    ]);
}

export function expectInterruptedAndFailedRunProjection(): void {
    const sessionId = 'session_replay_run_interrupted_failed';
    const replay = projectSessionReplay({
        sessionId,
        envelopes: [
            envelope(
                runEvent(sessionId, 'run.interrupted', 'user interrupted run', {
                    command: 'interrupt',
                    state: 'interrupted',
                    runId: 'run_1',
                    reason: 'user interrupt',
                }),
                0,
                'event_run_interrupted',
            ),
            envelope(
                runEvent(sessionId, 'run.failed', 'provider exploded', {
                    command: 'run',
                    state: 'failed',
                    runId: 'run_2',
                    reason: 'provider exploded',
                    errorCode: 'unknown',
                }),
                1,
                'event_run_failed',
            ),
        ],
    });

    expect(stepsWithKind(replay.codingSteps, 'run.state')).toEqual([
        expect.objectContaining({ eventId: 'event_run_interrupted', state: 'interrupted' }),
        expect.objectContaining({ eventId: 'event_run_failed', state: 'failed', errorCode: 'unknown' }),
    ]);
}

function stepsWithKind(steps: readonly { readonly kind: string }[], kind: string): readonly unknown[] {
    return steps.filter((step) => step.kind === kind);
}
