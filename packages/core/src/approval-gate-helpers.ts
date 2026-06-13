import type {
    AgentEvent,
    ApprovalRecord,
    PermissionDecision,
    PermissionReply,
    PermissionRequest,
} from '@mission-control/protocol';
import { type ApprovalTerminalState, PermissionGateError } from './approval-gate.js';

export type ApprovalEventType = Extract<
    AgentEvent['type'],
    'approval.requested' | 'approval.updated' | 'approval.blocked' | 'approval.resumed'
>;

export function approvalRecord(
    request: PermissionRequest,
    decision: PermissionDecision,
    approvalId: string,
    state: ApprovalRecord['state'],
    requestedAt: string,
    decidedAt?: string,
): ApprovalRecord {
    return {
        approvalId,
        requestId: request.id,
        policyDecision: decision.status === 'deny' ? 'deny' : 'requires_approval',
        state,
        subject: { kind: 'tool', id: request.action },
        requestedAt,
        ...(decidedAt !== undefined ? { decidedAt } : {}),
        reason: decision.reason ?? request.reason,
    };
}

export function approvalIdFor(requestId: string): string {
    return `approval_${requestId}`;
}

export function permissionError(
    code: PermissionGateError['code'],
    requestId: string,
    approvalId: string,
    reason = 'permission blocked',
): PermissionGateError {
    return new PermissionGateError({ code, requestId, approvalId, message: reason });
}

export function errorCodeFor(state: Exclude<ApprovalTerminalState, 'approved'>): PermissionGateError['code'] {
    switch (state) {
        case 'denied':
            return 'approval_denied';
        case 'expired':
            return 'approval_expired';
        case 'cancelled':
            return 'approval_cancelled';
    }
}

export function replyForApprovalState(state: ApprovalTerminalState): PermissionReply['reply'] {
    return state === 'approved' ? 'once' : 'deny';
}

export function approvedApprovalRecord(
    pending: {
        readonly record: ApprovalRecord;
    },
    timestamp: string,
    reason?: string,
): ApprovalRecord {
    return {
        ...pending.record,
        state: 'approved',
        decidedAt: timestamp,
        reason: reason ?? pending.record.reason,
    };
}

export function blockedApprovalRecord(
    pending: {
        readonly record: ApprovalRecord;
    },
    timestamp: string,
    state: Exclude<ApprovalTerminalState, 'approved'>,
    reason?: string,
): ApprovalRecord {
    return {
        ...pending.record,
        state,
        decidedAt: timestamp,
        reason: reason ?? pending.record.reason,
    };
}
