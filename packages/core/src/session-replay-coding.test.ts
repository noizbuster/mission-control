import { describe, expect, it } from 'vitest';
import { projectSessionReplay } from './session-replay.js';
import {
    approvalEvent,
    diffAppliedEvent,
    envelope,
    providerCompletedEvent,
    providerFailedEvent,
    providerToolCallEvent,
    runEvent,
    sessionStoppedEvent,
    toolCompletedEvent,
    toolFailedEvent,
} from './session-replay-coding-test-support.js';
import { expectBlockedApprovalAndResumedRunProjection } from './session-replay-run-state-test-support.js';

describe('session replay coding projections', () => {
    it('reconstructs provider tool calls, approvals, tool results, and continuation messages', () => {
        // Given
        const sessionId = 'session_replay_coding';
        const envelopes = [
            envelope(providerToolCallEvent(sessionId), 0, 'event_tool_call'),
            envelope(providerCompletedEvent(sessionId, 'task_prompt_1', 'patch requested'), 1, 'event_model_completed'),
            envelope(approvalEvent(sessionId, 'approval.requested', 'pending'), 2, 'event_approval_requested'),
            envelope(approvalEvent(sessionId, 'approval.updated', 'approved'), 3, 'event_approval_updated'),
            envelope(toolCompletedEvent(sessionId), 4, 'event_tool_completed'),
            envelope(
                providerCompletedEvent(sessionId, 'task_prompt_1_continue_1', 'final summary after tool result'),
                5,
                'event_model_completed_continue',
            ),
        ];

        // When
        const replay = projectSessionReplay({ sessionId, envelopes });

        // Then
        expect(replay.codingSteps).toEqual([
            {
                kind: 'provider.tool_call',
                eventId: 'event_tool_call',
                timestamp: '2026-06-05T10:00:00.000Z',
                taskId: 'task_prompt_1',
                toolCallId: 'patch_call',
                toolName: 'file.patch',
            },
            {
                kind: 'provider.message',
                eventId: 'event_model_completed',
                timestamp: '2026-06-05T10:00:01.000Z',
                providerTurnId: 'task_prompt_1',
                messageId: 'message_task_prompt_1',
                message: 'patch requested',
                continuation: false,
            },
            {
                kind: 'approval',
                eventId: 'event_approval_requested',
                timestamp: '2026-06-05T10:00:02.000Z',
                approvalId: 'approval_patch',
                state: 'pending',
                subject: { kind: 'tool', id: 'file.patch' },
            },
            {
                kind: 'approval',
                eventId: 'event_approval_updated',
                timestamp: '2026-06-05T10:00:02.000Z',
                approvalId: 'approval_patch',
                state: 'approved',
                subject: { kind: 'tool', id: 'file.patch' },
            },
            {
                kind: 'tool.result',
                eventId: 'event_tool_completed',
                timestamp: '2026-06-05T10:00:03.000Z',
                toolCallId: 'patch_call',
                status: 'completed',
                message: 'tool completed: file.patch',
                output: 'applied patch to notes.txt',
            },
            {
                kind: 'provider.message',
                eventId: 'event_model_completed_continue',
                timestamp: '2026-06-05T10:00:01.000Z',
                providerTurnId: 'task_prompt_1_continue_1',
                messageId: 'message_task_prompt_1_continue_1',
                message: 'final summary after tool result',
                continuation: true,
            },
        ]);
        expect(replay.diagnostics).toEqual([]);
        expect(replay.toolOutcomes).toMatchObject([
            {
                toolId: 'patch_call',
                status: 'completed',
                result: {
                    toolCallId: 'patch_call',
                    status: 'completed',
                    output: 'applied patch to notes.txt',
                },
            },
        ]);
    });

    it('diagnoses a stopped tool-result log with no provider continuation', () => {
        // Given
        const sessionId = 'session_replay_missing_continuation';
        const envelopes = [
            envelope(providerToolCallEvent(sessionId), 0, 'event_tool_call'),
            envelope(providerCompletedEvent(sessionId, 'task_prompt_1', 'patch requested'), 1, 'event_model_completed'),
            envelope(toolCompletedEvent(sessionId), 2, 'event_tool_completed'),
            envelope(sessionStoppedEvent(sessionId), 3, 'event_session_stopped'),
        ];

        // When
        const replay = projectSessionReplay({ sessionId, envelopes });

        // Then
        expect(replay.diagnostics).toEqual([
            {
                code: 'missing_provider_continuation',
                eventId: 'event_tool_completed',
                sessionId,
                toolCallId: 'patch_call',
                toolName: 'file.patch',
            },
        ]);
    });

    it('does not diagnose approval-blocked tool failures as missing continuations', () => {
        const sessionId = 'session_replay_approval_blocked_failure';
        const replay = projectSessionReplay({
            sessionId,
            envelopes: [
                envelope(providerToolCallEvent(sessionId), 0, 'event_tool_call'),
                envelope(
                    providerCompletedEvent(sessionId, 'task_prompt_1', 'approval required for patch'),
                    1,
                    'event_requested',
                ),
                envelope(
                    {
                        type: 'tool.failed',
                        timestamp: '2026-06-05T10:00:03.000Z',
                        sessionId,
                        taskId: 'patch_call',
                        message: 'tool failed: file.patch',
                        toolResult: {
                            toolCallId: 'patch_call',
                            status: 'failed',
                            error: {
                                code: 'tool_failed',
                                message: 'approval_denied: interactive CLI approval',
                                retryable: false,
                            },
                        },
                    },
                    2,
                    'event_tool_failed',
                ),
                envelope(
                    runEvent(sessionId, 'run.blocked', 'waiting for approval: file.patch', {
                        command: 'run',
                        state: 'blocked_on_approval',
                        runId: 'run_1',
                        reason: 'waiting for approval: file.patch',
                        errorCode: 'tool_failed',
                        toolCallId: 'patch_call',
                    }),
                    3,
                    'event_run_blocked',
                ),
                envelope(sessionStoppedEvent(sessionId), 4, 'event_session_stopped'),
            ],
        });

        expect(replay.diagnostics).toEqual([]);
    });

    it('keeps partial patch failures replayable with applied files', () => {
        // Given
        const sessionId = 'session_replay_coding_partial_failure';
        const envelopes = [
            envelope(diffAppliedEvent(sessionId), 0, 'event_diff_applied'),
            envelope(toolFailedEvent(sessionId), 1, 'event_tool_failed'),
        ];

        // When
        const replay = projectSessionReplay({ sessionId, envelopes });

        // Then
        expect(replay.toolOutcomes).toEqual([
            {
                toolId: 'patch_call',
                status: 'failed',
                failedAt: '2026-06-05T10:00:04.000Z',
                lastMessage: 'tool failed: file.patch',
                result: {
                    toolCallId: 'patch_call',
                    status: 'failed',
                    error: {
                        code: 'tool_failed',
                        message: 'partial_failed: applied a.txt; failed b.txt',
                        retryable: false,
                    },
                },
                appliedFiles: ['a.txt'],
            },
        ]);
    });

    it('replays partial failure diff events showing applied context without implying rollback', () => {
        const sessionId = 'session_replay_partial_boundary';
        const replay = projectSessionReplay({
            sessionId,
            envelopes: [
                envelope(diffAppliedEvent(sessionId), 0, 'event_partial_diff'),
                envelope(toolFailedEvent(sessionId), 1, 'event_tool_failed'),
            ],
        });

        const appliedSteps = replay.codingSteps.filter((step) => step.kind === 'tool.result');
        expect(appliedSteps).toHaveLength(1);
        expect(appliedSteps[0]).toMatchObject({
            kind: 'tool.result',
            toolCallId: 'patch_call',
            status: 'failed',
            appliedFiles: ['a.txt'],
        });

        expect(replay.diagnostics).toEqual([]);
        expect(replay.toolOutcomes[0]?.appliedFiles).toEqual(['a.txt']);
    });

    it('replays denied patches without diff applied events or rollback implication', () => {
        const sessionId = 'session_replay_denied_patch';
        const replay = projectSessionReplay({
            sessionId,
            envelopes: [
                envelope(providerToolCallEvent(sessionId), 0, 'event_tool_call'),
                envelope(
                    providerCompletedEvent(sessionId, 'task_prompt_1', 'approval requested'),
                    1,
                    'event_requested',
                ),
                envelope(
                    {
                        type: 'tool.failed',
                        timestamp: '2026-06-05T10:00:03.000Z',
                        sessionId,
                        taskId: 'patch_call',
                        message: 'tool failed: file.patch',
                        toolResult: {
                            toolCallId: 'patch_call',
                            status: 'failed',
                            error: {
                                code: 'tool_failed',
                                message: 'approval_denied: interactive CLI approval',
                                retryable: false,
                            },
                        },
                    },
                    2,
                    'event_tool_denied',
                ),
                envelope(sessionStoppedEvent(sessionId), 3, 'event_session_stopped'),
            ],
        });

        expect(replay.toolOutcomes).toEqual([
            {
                toolId: 'patch_call',
                status: 'failed',
                failedAt: '2026-06-05T10:00:03.000Z',
                lastMessage: 'tool failed: file.patch',
                result: {
                    toolCallId: 'patch_call',
                    status: 'failed',
                    error: {
                        code: 'tool_failed',
                        message: 'approval_denied: interactive CLI approval',
                        retryable: false,
                    },
                },
            },
        ]);
        expect(replay.codingSteps.filter((step) => step.kind === 'tool.result')).toHaveLength(1);
    });

    it('projects blocked approval and resumed run', () => {
        expectBlockedApprovalAndResumedRunProjection();
    });

    it('treats provider output after a resume start as a tool continuation', () => {
        const sessionId = 'session_replay_resume_continuation';
        const replay = projectSessionReplay({
            sessionId,
            envelopes: [
                envelope(providerToolCallEvent(sessionId), 0, 'event_tool_call'),
                envelope(providerCompletedEvent(sessionId, 'task_prompt_1', 'patch requested'), 1, 'event_requested'),
                envelope(toolCompletedEvent(sessionId), 2, 'event_tool_completed'),
                envelope(
                    runEvent(sessionId, 'run.started', 'run resumed', {
                        command: 'resume',
                        state: 'running',
                        runId: 'run_1',
                    }),
                    3,
                    'event_resume_started',
                ),
                envelope(
                    providerCompletedEvent(sessionId, 'turn_2', 'continued after approved tool result'),
                    4,
                    'event_resume_response',
                ),
            ],
        });

        expect(replay.diagnostics).toEqual([]);
        expect(replay.codingSteps).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    kind: 'provider.message',
                    eventId: 'event_resume_response',
                    continuation: true,
                }),
            ]),
        );
    });

    it('projects provider failure as failure, not misleading success output', () => {
        const sessionId = 'session_replay_provider_failure';
        const replay = projectSessionReplay({
            sessionId,
            envelopes: [
                envelope(providerToolCallEvent(sessionId), 0, 'event_tool_call'),
                envelope(providerFailedEvent(sessionId), 1, 'event_provider_failed'),
                envelope(
                    runEvent(sessionId, 'run.failed', 'provider exploded', {
                        command: 'run',
                        state: 'failed',
                        runId: 'run_1',
                        reason: 'provider exploded',
                        errorCode: 'unknown',
                    }),
                    2,
                    'event_run_failed',
                ),
            ],
        });

        const failureSteps = replay.codingSteps.filter((step) => step.kind === 'provider.failure');
        const messageSteps = replay.codingSteps.filter((step) => step.kind === 'provider.message');
        expect(failureSteps).toHaveLength(1);
        expect(failureSteps[0]).toMatchObject({
            kind: 'provider.failure',
            requestId: 'provider_request_task_prompt_1',
            error: { code: 'unknown', message: 'provider exploded' },
        });
        expect(messageSteps).toHaveLength(0);

        const runStateSteps = replay.codingSteps.filter((step) => step.kind === 'run.state');
        expect(runStateSteps).toEqual(
            expect.arrayContaining([expect.objectContaining({ state: 'failed', errorCode: 'unknown' })]),
        );
        expect(runStateSteps.some((step) => 'state' in step && step.state === 'completed')).toBe(false);
    });
});
