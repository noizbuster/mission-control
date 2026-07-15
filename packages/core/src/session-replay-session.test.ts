import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { deriveReplaySession } from './session-replay-session';

const SESSION_ID = 'session_replay_abort_marker';

describe('session replay lifecycle', () => {
    it('derives reusable idle from an abort marker after the interrupted run quiesces', () => {
        const session = deriveReplaySession(SESSION_ID, [runStarted(), runInterrupted(), abortCompleted()]);

        expect(session).toMatchObject({ id: SESSION_ID, status: 'idle' });
        expect(session).not.toHaveProperty('stoppedAt');
    });

    it('lets a later run.started supersede the abort marker', () => {
        const session = deriveReplaySession(SESSION_ID, [
            runStarted(),
            runInterrupted(),
            abortCompleted(),
            runStarted('run_next', '2026-07-11T10:00:04.000Z'),
        ]);

        expect(session.status).toBe('running');
    });

    it('clears an approval wait cancelled before marker-only cleanup', () => {
        const session = deriveReplaySession(SESSION_ID, [
            approvalRequested(),
            runBlocked(),
            approvalCancelled(),
            abortCompleted(),
        ]);

        expect(session).toMatchObject({ status: 'idle' });
        expect(session).not.toHaveProperty('awaiting');
    });
});

function runStarted(runId = 'run_active', timestamp = '2026-07-11T10:00:00.000Z'): AgentEvent {
    return {
        type: 'run.started',
        timestamp,
        sessionId: SESSION_ID,
        run: { command: 'run', state: 'running', runId },
    };
}

function runInterrupted(): AgentEvent {
    return {
        type: 'run.interrupted',
        timestamp: '2026-07-11T10:00:02.000Z',
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

function abortCompleted(): AgentEvent {
    return {
        type: 'session.abort.completed',
        timestamp: '2026-07-11T10:00:03.000Z',
        sessionId: SESSION_ID,
        sessionStop: {
            operationId: 'operation_stop',
            requestId: 'request_stop',
            reason: 'operator_aborted',
            affected: {
                runs: 1,
                approvals: 1,
                sessionAwaits: 1,
                sessionInputs: 0,
                missionRuns: 0,
                asyncJobs: 0,
                toolCalls: 0,
            },
        },
    };
}

function approvalRequested(): AgentEvent {
    return approvalEvent('approval.requested', 'pending', '2026-07-11T10:00:00.000Z');
}

function approvalCancelled(): AgentEvent {
    return approvalEvent('approval.updated', 'cancelled', '2026-07-11T10:00:02.000Z');
}

function approvalEvent(
    type: 'approval.requested' | 'approval.updated',
    state: 'pending' | 'cancelled',
    timestamp: string,
): AgentEvent {
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
            requestedAt: '2026-07-11T10:00:00.000Z',
            ...(state === 'cancelled' ? { decidedAt: timestamp, reason: 'operator_aborted' } : {}),
        },
    };
}

function runBlocked(): AgentEvent {
    return {
        type: 'run.blocked',
        timestamp: '2026-07-11T10:00:01.000Z',
        sessionId: SESSION_ID,
        run: { command: 'run', state: 'blocked_on_approval', runId: 'run_active', toolCallId: 'tool_stop' },
    };
}
