import type { AgentEvent, AgentEventEnvelope, RunCoordinatorEventMetadata } from '@mission-control/protocol';

export function providerToolCallEvent(sessionId: string): AgentEvent {
    return {
        type: 'task.progress',
        timestamp: '2026-06-05T10:00:00.000Z',
        sessionId,
        taskId: 'task_prompt_1',
        message: 'tool call completed: file.patch',
        providerStreamChunk: {
            kind: 'tool_call_completed',
            requestId: 'provider_request_task_prompt_1',
            sequence: 1,
            toolCall: {
                toolCallId: 'patch_call',
                toolName: 'file.patch',
                argumentsJson: '{"patch":"diff"}',
            },
        },
    };
}

export function providerCompletedEvent(sessionId: string, providerTurnId: string, content: string): AgentEvent {
    return {
        type: 'model.call.completed',
        timestamp: '2026-06-05T10:00:01.000Z',
        sessionId,
        taskId: 'task_prompt_1',
        message: content,
        providerStreamChunk: {
            kind: 'response_completed',
            requestId: `provider_request_${providerTurnId}`,
            sequence: 2,
            message: {
                messageId: `message_${providerTurnId}`,
                role: 'assistant',
                content,
            },
            finishReason: 'stop',
        },
        transcript: {
            providerTurnId,
            messageId: `message_${providerTurnId}`,
            visibility: 'model_visible',
        },
    };
}

export function providerFailedEvent(sessionId: string): AgentEvent {
    return {
        type: 'model.call.failed',
        timestamp: '2026-06-05T10:00:01.000Z',
        sessionId,
        taskId: 'task_prompt_1',
        message: 'provider exploded',
        providerStreamChunk: {
            kind: 'response_failed',
            requestId: 'provider_request_task_prompt_1',
            sequence: 2,
            error: {
                code: 'unknown',
                message: 'provider exploded',
                retryable: false,
            },
        },
        transcript: {
            providerTurnId: 'task_prompt_1',
            messageId: 'message_task_prompt_1',
            visibility: 'model_visible',
        },
    };
}

export function approvalEvent(
    sessionId: string,
    type: 'approval.requested' | 'approval.updated',
    state: 'pending' | 'approved',
): AgentEvent {
    return {
        type,
        timestamp: '2026-06-05T10:00:02.000Z',
        sessionId,
        message: `approval ${state}`,
        approvalRecord: {
            approvalId: 'approval_patch',
            requestId: 'permission_patch',
            policyDecision: 'requires_approval',
            state,
            subject: { kind: 'tool', id: 'file.patch' },
            requestedAt: '2026-06-05T10:00:02.000Z',
            ...(state === 'approved' ? { decidedAt: '2026-06-05T10:00:02.000Z' } : {}),
        },
    };
}

export function toolCompletedEvent(sessionId: string): AgentEvent {
    return {
        type: 'tool.completed',
        timestamp: '2026-06-05T10:00:03.000Z',
        sessionId,
        taskId: 'patch_call',
        message: 'tool completed: file.patch',
        toolResult: {
            toolCallId: 'patch_call',
            status: 'completed',
            output: 'applied patch to notes.txt',
        },
    };
}

export function diffAppliedEvent(sessionId: string): AgentEvent {
    return {
        type: 'file.diff.applied',
        timestamp: '2026-06-05T10:00:03.000Z',
        sessionId,
        taskId: 'patch_call',
        message: 'patch partially applied',
        diffFiles: [
            {
                filePath: 'a.txt',
                changeKind: 'modified',
                hunks: [
                    {
                        oldStart: 1,
                        oldLines: 1,
                        newStart: 1,
                        newLines: 1,
                        lines: [{ kind: 'added', content: 'ONE' }],
                    },
                ],
            },
        ],
    };
}

export function toolFailedEvent(sessionId: string): AgentEvent {
    return {
        type: 'tool.failed',
        timestamp: '2026-06-05T10:00:04.000Z',
        sessionId,
        taskId: 'patch_call',
        message: 'tool failed: file.patch',
        toolResult: {
            toolCallId: 'patch_call',
            status: 'failed',
            error: {
                code: 'tool_failed',
                message: 'partial_failed: applied a.txt; failed b.txt',
                retryable: false,
            },
        },
    };
}

export function sessionStoppedEvent(sessionId: string): AgentEvent {
    return {
        type: 'session.stopped',
        timestamp: '2026-06-05T10:00:05.000Z',
        sessionId,
        message: 'mission-control session stopped',
    };
}

export function runEvent(
    sessionId: string,
    type: AgentEvent['type'],
    message: string,
    run: RunCoordinatorEventMetadata,
): AgentEvent {
    return {
        type,
        timestamp: '2026-06-05T10:00:06.000Z',
        sessionId,
        message,
        run,
    };
}

export function envelope(event: AgentEvent, sequence: number, eventId: string): AgentEventEnvelope {
    return {
        eventId,
        sequence,
        createdAt: event.timestamp,
        sessionId: event.sessionId ?? 'session_missing',
        durability: 'durable',
        event,
    };
}
