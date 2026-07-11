import type { AgentEvent } from '@mission-control/protocol';

export const SESSION_ID = 'session_stop_projection';

export function abortedSessionEvents(): readonly AgentEvent[] {
    return [
        sessionStarted(),
        promptAdmitted(),
        approvalEvent('approval.requested', 'pending'),
        runEvent('run.started', 'running'),
        runEvent('run.blocked', 'blocked_on_approval'),
        promptCancelled(),
        approvalEvent('approval.updated', 'cancelled'),
        runInterrupted(),
        providerFailure('provider_aborted'),
        graphProviderAborted(),
        providerFailure('unknown'),
        abortCompleted(1),
    ];
}

export function approvalWaitWithCancelledInputEvents(): readonly AgentEvent[] {
    return [
        sessionStarted(),
        promptAdmitted(),
        approvalEvent('approval.requested', 'pending'),
        runEvent('run.started', 'running'),
        runEvent('run.blocked', 'blocked_on_approval'),
        promptCancelled(),
    ];
}

export function sessionStarted(): AgentEvent {
    return { type: 'session.started', timestamp: '2026-07-11T10:00:00.000Z', sessionId: SESSION_ID };
}

function promptAdmitted(): AgentEvent {
    return {
        type: 'prompt.admitted',
        timestamp: '2026-07-11T10:00:01.000Z',
        sessionId: SESSION_ID,
        message: 'cancel me',
        transcript: {
            inputId: 'input_cancelled',
            messageId: 'message_cancelled',
            delivery: 'queue',
            visibility: 'pending',
        },
    };
}

function promptCancelled(): AgentEvent {
    return {
        type: 'prompt.cancelled',
        timestamp: '2026-07-11T10:00:05.000Z',
        sessionId: SESSION_ID,
        transcript: {
            inputId: 'input_cancelled',
            delivery: 'queue',
            requestId: 'request_stop',
            reason: 'operator_aborted',
        },
    };
}

function approvalEvent(type: 'approval.requested' | 'approval.updated', state: 'pending' | 'cancelled'): AgentEvent {
    const timestamp = state === 'pending' ? '2026-07-11T10:00:02.000Z' : '2026-07-11T10:00:06.000Z';
    return {
        type,
        timestamp,
        sessionId: SESSION_ID,
        approvalRecord: {
            approvalId: 'approval_stop',
            requestId: 'request_approval',
            policyDecision: 'requires_approval',
            state,
            subject: { kind: 'tool', id: 'tool_stop' },
            requestedAt: '2026-07-11T10:00:02.000Z',
            ...(state === 'cancelled' ? { decidedAt: timestamp, reason: 'operator_aborted' } : {}),
        },
    };
}

function runEvent(type: 'run.started' | 'run.blocked', state: 'running' | 'blocked_on_approval'): AgentEvent {
    return {
        type,
        timestamp: state === 'running' ? '2026-07-11T10:00:03.000Z' : '2026-07-11T10:00:04.000Z',
        sessionId: SESSION_ID,
        run: {
            command: 'run',
            state,
            runId: 'run_active',
            ...(state === 'blocked_on_approval' ? { toolCallId: 'tool_stop' } : {}),
        },
    };
}

function runInterrupted(): AgentEvent {
    return {
        type: 'run.interrupted',
        timestamp: '2026-07-11T10:00:07.000Z',
        sessionId: SESSION_ID,
        run: {
            state: 'interrupted',
            runId: 'run_active',
            requestId: 'request_stop',
            operationId: 'operation_stop',
            reason: 'operator_aborted',
        },
    };
}

function providerFailure(code: 'provider_aborted' | 'unknown'): AgentEvent {
    return {
        type: 'model.call.failed',
        timestamp: code === 'provider_aborted' ? '2026-07-11T10:00:08.000Z' : '2026-07-11T10:00:09.000Z',
        sessionId: SESSION_ID,
        message: code,
        providerStreamChunk: {
            kind: 'response_failed',
            requestId: `request_${code}`,
            sequence: 1,
            error: { code, message: code, retryable: false },
        },
    };
}

function graphProviderAborted(): AgentEvent {
    return {
        type: 'log',
        timestamp: '2026-07-11T10:00:08.500Z',
        sessionId: SESSION_ID,
        message: 'node emitted event: llm.error',
        abg: {
            graphId: 'graph_stop',
            nodeId: 'llm_stop',
            nodeKind: 'llm',
            signalType: 'emit',
            emit: {
                type: 'llm.error',
                payload: { error: 'provider aborted', errorCode: 'provider_aborted' },
            },
        },
    };
}

export function abortCompleted(runs: number): AgentEvent {
    return {
        type: 'session.abort.completed',
        timestamp: '2026-07-11T10:00:10.000Z',
        sessionId: SESSION_ID,
        sessionStop: {
            operationId: 'operation_stop',
            requestId: 'request_stop',
            reason: 'operator_aborted',
            affected: {
                runs,
                approvals: 1,
                sessionAwaits: 2,
                sessionInputs: 1,
                missionRuns: 0,
                asyncJobs: 0,
                toolCalls: 0,
            },
        },
    };
}

export function auditEvent(): AgentEvent {
    return { type: 'log', timestamp: '2026-07-11T10:00:11.000Z', sessionId: SESSION_ID, message: 'authority settled' };
}

export function nextRunStarted(): AgentEvent {
    return {
        type: 'run.started',
        timestamp: '2026-07-11T10:00:12.000Z',
        sessionId: SESSION_ID,
        run: { command: 'run', state: 'running', runId: 'run_next' },
    };
}
