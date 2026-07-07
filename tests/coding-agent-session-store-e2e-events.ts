import type { AgentEvent } from '../packages/protocol/src/index.js';

const CREATED_AT = '2026-07-06T00:00:00.000Z';
const WORKSPACE_ROOT = '/workspace/mission-control-e2e';

export function sessionStartedEvent(sessionId: string): AgentEvent {
    return {
        type: 'session.started',
        timestamp: CREATED_AT,
        sessionId,
        message: 'mission-control session started',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: { providerID: 'local', modelID: 'test' },
    };
}

export function metadataEvent(sessionId: string): AgentEvent {
    return {
        type: 'session.metadata.updated',
        timestamp: '2026-07-06T00:00:01.000Z',
        sessionId,
        message: 'session metadata updated',
        sessionTree: {
            kind: 'metadata',
            cwd: WORKSPACE_ROOT,
            trustedRoot: WORKSPACE_ROOT,
            workspaceTrust: 'trusted',
        },
    };
}

export function runEvent(
    sessionId: string,
    type: AgentEvent['type'],
    message: string,
    run: NonNullable<AgentEvent['run']>,
): AgentEvent {
    return { type, timestamp: '2026-07-06T00:00:02.000Z', sessionId, message, run };
}

export function providerToolCallEvent(sessionId: string): AgentEvent {
    return {
        type: 'model.call.completed',
        timestamp: '2026-07-06T00:00:03.000Z',
        sessionId,
        taskId: 'turn_parent',
        message: 'tool call completed: file.patch',
        providerStreamChunk: {
            kind: 'tool_call_completed',
            requestId: 'request_parent',
            sequence: 0,
            toolCall: {
                toolCallId: 'patch_call',
                toolName: 'file.patch',
                argumentsJson: '{"patch":"diff"}',
            },
        },
    };
}

export function providerCompletedEvent(sessionId: string): AgentEvent {
    return {
        type: 'model.call.completed',
        timestamp: '2026-07-06T00:00:03.500Z',
        sessionId,
        taskId: 'turn_parent',
        message: 'assistant summary',
        providerStreamChunk: {
            kind: 'response_completed',
            requestId: 'request_parent',
            sequence: 1,
            message: {
                messageId: 'message_parent',
                role: 'assistant',
                content: 'assistant summary',
            },
            finishReason: 'stop',
        },
        transcript: {
            providerTurnId: 'turn_parent',
            messageId: 'message_parent',
            visibility: 'model_visible',
        },
    };
}

export function providerFailedEvent(sessionId: string): AgentEvent {
    return {
        type: 'model.call.failed',
        timestamp: '2026-07-06T00:00:08.500Z',
        sessionId,
        taskId: 'turn_parent',
        message: 'provider failed after tool completion',
        providerStreamChunk: {
            kind: 'response_failed',
            requestId: 'request_parent',
            sequence: 2,
            error: {
                code: 'unknown',
                message: 'provider failed after tool completion',
                retryable: false,
            },
        },
        transcript: {
            providerTurnId: 'turn_parent',
            messageId: 'message_parent',
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
        timestamp: '2026-07-06T00:00:04.000Z',
        sessionId,
        message: `approval ${state}`,
        approvalRecord: approvalRecord(state),
    };
}

export function approvalResumedEvent(sessionId: string): AgentEvent {
    return {
        type: 'approval.resumed',
        timestamp: '2026-07-06T00:00:07.000Z',
        sessionId,
        message: 'approval resumed',
        approvalRecord: approvalRecord('approved'),
    };
}

function approvalRecord(state: 'pending' | 'approved'): NonNullable<AgentEvent['approvalRecord']> {
    return {
        approvalId: 'approval_patch',
        requestId: 'permission_patch',
        state,
        requestedAt: '2026-07-06T00:00:04.000Z',
        ...(state === 'approved' ? { decidedAt: '2026-07-06T00:00:06.000Z' } : {}),
        subject: { kind: 'tool', id: 'file.patch' },
        policyDecision: 'requires_approval',
    };
}

export function toolCompletedEvent(sessionId: string): AgentEvent {
    return {
        type: 'tool.completed',
        timestamp: '2026-07-06T00:00:08.000Z',
        sessionId,
        taskId: 'patch_call',
        message: 'tool completed: file.patch',
        toolResult: {
            toolCallId: 'patch_call',
            status: 'completed',
            output: 'applied patch',
        },
    };
}

export function sessionStoppedEvent(sessionId: string, second: number): AgentEvent {
    return {
        type: 'session.stopped',
        timestamp: `2026-07-06T00:00:0${second}.000Z`,
        sessionId,
        message: 'mission-control session stopped',
    };
}
