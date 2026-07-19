import { openLocalSessionProjectionStore, type SessionProjectionSessionRecord } from '@mission-control/core';
import type { AgentEventEnvelope, SessionAwaitingDetails } from '@mission-control/protocol';

export const SESSION_STATUS_FIXTURE_IDS = {
    approval: 'session_status_approval',
    userInput: 'session_status_question',
    subagent: 'session_status_child',
    cleared: 'session_status_cleared',
} as const;

type SessionStatusFixture = {
    readonly sessionId: string;
    readonly status: SessionProjectionSessionRecord['status'];
    readonly updatedAt: string;
    readonly awaiting?: SessionAwaitingDetails;
};

const SESSION_STATUS_FIXTURES: readonly SessionStatusFixture[] = [
    {
        sessionId: SESSION_STATUS_FIXTURE_IDS.approval,
        status: 'awaiting',
        updatedAt: '2026-07-04T10:00:03.000Z',
        awaiting: {
            reason: 'approval',
            source: { approvalId: 'approval_patch', runId: 'run_approval', toolCallId: 'patch_call' },
        },
    },
    {
        sessionId: SESSION_STATUS_FIXTURE_IDS.userInput,
        status: 'awaiting',
        updatedAt: '2026-07-04T10:00:04.000Z',
        awaiting: {
            reason: 'user_input',
            source: { runId: 'run_question', toolCallId: 'ask_user_pending' },
        },
    },
    {
        sessionId: SESSION_STATUS_FIXTURE_IDS.subagent,
        status: 'awaiting',
        updatedAt: '2026-07-04T10:00:05.000Z',
        awaiting: {
            reason: 'subagent',
            source: {
                runId: 'run_subagent',
                toolCallId: 'task_call',
                jobId: 'job_child',
                childSessionId: 'session_status_child_worker',
            },
        },
    },
    {
        sessionId: SESSION_STATUS_FIXTURE_IDS.cleared,
        status: 'idle',
        updatedAt: '2026-07-04T10:00:06.000Z',
    },
];

export async function writeSessionStatusFixtureSessions(dataDir: string): Promise<void> {
    const store = await openLocalSessionProjectionStore({ dataDir });
    try {
        for (const fixture of SESSION_STATUS_FIXTURES) {
            await store.replaceSessionProjection({
                sessionId: fixture.sessionId,
                records: [sessionRecord(fixture)],
                diagnostics: [],
                envelopes: [sessionEnvelope(fixture)],
            });
        }
    } finally {
        store.close();
    }
}

function sessionRecord(fixture: SessionStatusFixture): SessionProjectionSessionRecord {
    return {
        kind: 'session',
        sessionId: fixture.sessionId,
        status: fixture.status,
        ...(fixture.awaiting !== undefined ? { awaiting: fixture.awaiting } : {}),
        startedAt: '2026-07-04T10:00:00.000Z',
        eventCount: 1,
        lastSequence: 0,
        lastEventId: `evt_${fixture.sessionId}_0`,
        lastEventType: 'session.started',
        updatedAt: fixture.updatedAt,
        sourcePath: '',
    };
}

function sessionEnvelope(fixture: SessionStatusFixture): AgentEventEnvelope {
    return {
        eventId: `evt_${fixture.sessionId}_0`,
        sequence: 0,
        createdAt: fixture.updatedAt,
        sessionId: fixture.sessionId,
        durability: 'durable',
        event: {
            type: 'session.started',
            timestamp: fixture.updatedAt,
            sessionId: fixture.sessionId,
            message: 'session fixture projection source',
        },
    };
}
