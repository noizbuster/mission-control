import type { AgentEvent, AgentEventEnvelope, ApprovalRecord } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { projectSessionReplay } from './session-replay.js';

describe('session replay approval lifecycle projection', () => {
    it('reconstructs blocked and resumed approval states from durable events', () => {
        // Given
        const sessionId = 'session_replay_approval_lifecycle';
        const deniedApproval = approvalRecord({
            approvalId: 'approval_delete',
            requestId: 'permission_delete',
            state: 'denied',
            reason: 'denied by reviewer',
            decidedAt: '2026-06-05T10:00:01.000Z',
        });
        const approvedApproval = approvalRecord({
            approvalId: 'approval_patch',
            requestId: 'permission_patch',
            state: 'approved',
            reason: 'approved by reviewer',
            decidedAt: '2026-06-05T10:00:04.000Z',
        });
        const envelopes = [
            envelope(approvalEvent('approval.requested', sessionId, pendingApproval('approval_delete')), 0, {
                eventId: 'event_delete_requested',
            }),
            envelope(approvalEvent('approval.blocked', sessionId, deniedApproval), 1, {
                eventId: 'event_delete_blocked',
            }),
            envelope(approvalEvent('approval.requested', sessionId, pendingApproval('approval_patch')), 2, {
                eventId: 'event_patch_requested',
            }),
            envelope(approvalEvent('approval.updated', sessionId, approvedApproval), 3, {
                eventId: 'event_patch_updated',
            }),
            envelope(approvalEvent('approval.resumed', sessionId, approvedApproval), 4, {
                eventId: 'event_patch_resumed',
            }),
        ];

        // When
        const replay = projectSessionReplay({ sessionId, envelopes });

        // Then
        expect(replay.approvals).toMatchObject([
            {
                approvalId: 'approval_delete',
                state: 'denied',
                eventId: 'event_delete_blocked',
            },
            {
                approvalId: 'approval_patch',
                state: 'approved',
                eventId: 'event_patch_resumed',
            },
        ]);
    });
});

type ApprovalInput = {
    readonly approvalId: string;
    readonly requestId: string;
    readonly state: ApprovalRecord['state'];
    readonly reason: string;
    readonly decidedAt?: string;
};

type EnvelopeOptions = {
    readonly eventId: string;
};

function pendingApproval(approvalId: string): ApprovalRecord {
    return approvalRecord({
        approvalId,
        requestId: approvalId.replace('approval_', 'permission_'),
        state: 'pending',
        reason: 'approval required',
    });
}

function approvalRecord(input: ApprovalInput): ApprovalRecord {
    return {
        approvalId: input.approvalId,
        requestId: input.requestId,
        policyDecision: 'requires_approval',
        state: input.state,
        subject: {
            kind: 'tool',
            id: 'file.patch',
        },
        requestedAt: '2026-06-05T10:00:00.000Z',
        ...(input.decidedAt !== undefined ? { decidedAt: input.decidedAt } : {}),
        reason: input.reason,
    };
}

function approvalEvent(type: AgentEvent['type'], sessionId: string, approvalRecord: ApprovalRecord): AgentEvent {
    return {
        type,
        timestamp: approvalRecord.decidedAt ?? approvalRecord.requestedAt,
        sessionId,
        message: `approval event: ${type}`,
        approvalRecord,
    };
}

function envelope(event: AgentEvent, sequence: number, options: EnvelopeOptions): AgentEventEnvelope {
    return {
        eventId: options.eventId,
        sequence,
        createdAt: event.timestamp,
        sessionId: event.sessionId ?? 'session_missing',
        durability: 'durable',
        event,
    };
}
