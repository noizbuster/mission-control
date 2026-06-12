import { describe, expect, it } from 'vitest';
import { projectSessionReplay } from './session-replay.js';
import {
    approvalEvent,
    diffAppliedEvent,
    envelope,
    providerCompletedEvent,
    providerToolCallEvent,
    sessionStoppedEvent,
    toolCompletedEvent,
    toolFailedEvent,
} from './session-replay-coding-test-support.js';

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
});
