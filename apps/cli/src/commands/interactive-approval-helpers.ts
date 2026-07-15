import type {
    AgentEvent,
    ApprovalRecord,
    PermissionDecision,
    PermissionReply,
    PermissionRequest,
} from '@mission-control/protocol';
import type { InteractiveToolOptions } from './interactive-coding-tools.js';

export function parsePermissionReply(line: string): PermissionReply {
    const answer = line.trim().toLowerCase();
    if (answer === 'a' || answer === 'always') {
        return { approvalId: '', reply: 'always', reason: 'interactive CLI approval', persist: true };
    }
    if (answer === 's' || answer === 'session') {
        return { approvalId: '', reply: 'always', reason: 'interactive CLI approval (session)' };
    }
    if (answer === 'y' || answer === 'yes' || answer === 'allow' || answer === 'o' || answer === 'once') {
        return { approvalId: '', reply: 'once', reason: 'interactive CLI approval' };
    }
    return { approvalId: '', reply: 'deny', reason: 'interactive CLI approval' };
}

export function renderApprovalResult(action: string, reply: PermissionReply['reply'], reason?: string): string {
    if (reply === 'always' && reason?.includes('session')) {
        return `Allowed for session: ${action}\n`;
    }
    switch (reply) {
        case 'always':
            return `Always allow ${action}\n`;
        case 'once':
            return `Approved once ${action}\n`;
        case 'deny':
            return `Denied ${action}\n`;
    }
}

export function eventWithPermission(
    options: InteractiveToolOptions,
    request: PermissionRequest,
    decision: PermissionDecision,
): AgentEvent {
    return {
        type: 'permission.requested',
        timestamp: new Date().toISOString(),
        sessionId: options.sessionId,
        message: `permission requested: ${request.action}`,
        permissionRequest: request,
        permissionDecision: decision,
        modelProviderSelection: options.modelProviderSelection,
    };
}

export function eventWithReply(options: InteractiveToolOptions, reply: PermissionReply): AgentEvent {
    return {
        type: 'permission.replied',
        timestamp: new Date().toISOString(),
        sessionId: options.sessionId,
        message: `permission replied: ${reply.reply}`,
        permissionReply: reply,
        modelProviderSelection: options.modelProviderSelection,
    };
}

export function eventWithApproval(
    options: InteractiveToolOptions,
    type: 'approval.requested' | 'approval.updated' | 'approval.blocked' | 'approval.resumed',
    record: ApprovalRecord,
    message: string,
): AgentEvent {
    return {
        type,
        timestamp: new Date().toISOString(),
        sessionId: options.sessionId,
        message,
        approvalRecord: record,
        modelProviderSelection: options.modelProviderSelection,
    };
}

export function approvalIdFor(request: PermissionRequest): string {
    return `approval_${request.id}`;
}

export function approvalRecordForRequest(request: PermissionRequest, decision: PermissionDecision): ApprovalRecord {
    return {
        approvalId: approvalIdFor(request),
        requestId: request.id,
        policyDecision: decision.status,
        state: 'pending',
        subject: { kind: 'tool', id: request.action },
        requestedAt: new Date().toISOString(),
        reason: decision.reason ?? request.reason,
    };
}

export function approvalDecisionRecord(record: ApprovalRecord, reply: PermissionReply): ApprovalRecord {
    return {
        ...record,
        state: reply.reply === 'deny' ? 'denied' : 'approved',
        decidedAt: new Date().toISOString(),
        reason: reply.reason ?? record.reason,
    };
}
