import { createObservabilityRedactor } from '@mission-control/core';
import type {
    AgentEvent,
    ApprovalRecord,
    PermissionDecision,
    PermissionReply,
    PermissionRequest,
} from '@mission-control/protocol';
import { buildAgentEvent } from './interactive-agent-event';
import type { InteractiveToolOptions } from './interactive-coding-tools';

export type VisibleApprovalAttempt = {
    readonly state: 'visible';
    readonly identity: symbol;
    readonly request: PermissionRequest;
    readonly record: ApprovalRecord;
    readonly resolve: (decision: PermissionDecision) => void;
};

export type ApprovalAttempt =
    | { readonly state: 'evaluating'; readonly identity: symbol; readonly request: PermissionRequest }
    | {
          readonly state: 'cancelled';
          readonly identity: symbol;
          readonly request: PermissionRequest;
          readonly reason: string;
      }
    | VisibleApprovalAttempt
    | {
          readonly state: 'settling';
          readonly identity: symbol;
          readonly request: PermissionRequest;
          readonly commitState: 'open' | 'claimed';
          readonly cancellationReason?: string;
      };

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


/** True when a line is approval-vocab only (UI once/session/always/deny + short aliases). */
export function isApprovalDecisionLine(line: string): boolean {
    const answer = line.trim().toLowerCase();
    switch (answer) {
        case 'once':
        case 'o':
        case 'session':
        case 's':
        case 'always':
        case 'a':
        case 'deny':
        case 'n':
        case 'no':
        case 'y':
        case 'yes':
        case 'allow':
            return true;
        default:
            return false;
    }
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
    return buildAgentEvent({
        type: 'permission.requested',
        sessionId: options.sessionId,
        message: `permission requested: ${request.action}`,
        permissionRequest: request,
        permissionDecision: decision,
        modelProviderSelection: options.modelProviderSelection,
    });
}

export function eventWithReply(options: InteractiveToolOptions, reply: PermissionReply): AgentEvent {
    return buildAgentEvent({
        type: 'permission.replied',
        sessionId: options.sessionId,
        message: `permission replied: ${reply.reply}`,
        permissionReply: reply,
        modelProviderSelection: options.modelProviderSelection,
    });
}

export function eventWithApproval(
    options: InteractiveToolOptions,
    type: 'approval.requested' | 'approval.updated' | 'approval.blocked' | 'approval.resumed',
    record: ApprovalRecord,
    message: string,
): AgentEvent {
    return buildAgentEvent({
        type,
        sessionId: options.sessionId,
        message,
        approvalRecord: record,
        modelProviderSelection: options.modelProviderSelection,
    });
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

export function settleApprovalReply(
    options: InteractiveToolOptions,
    request: PermissionRequest,
    record: ApprovalRecord,
    reply: PermissionReply,
): PermissionDecision {
    options.output.write('\n');
    options.output.hideApproval?.();
    options.output.write(renderApprovalResult(request.action, reply.reply, reply.reason));
    options.emitEvent(eventWithReply(options, reply));
    const decidedRecord = approvalDecisionRecord(record, reply);
    options.emitEvent(
        eventWithApproval(options, 'approval.updated', decidedRecord, `approval updated: ${decidedRecord.state}`),
    );
    options.emitEvent(
        eventWithApproval(
            options,
            reply.reply === 'deny' ? 'approval.blocked' : 'approval.resumed',
            decidedRecord,
            reply.reply === 'deny' ? `approval blocked: ${decidedRecord.state}` : 'approval resumed',
        ),
    );
    return {
        requestId: request.id,
        status: reply.reply === 'deny' ? 'deny' : 'allow',
        reason: reply.reason ?? 'interactive CLI approval',
    };
}

export function prepareApprovalReply(
    options: InteractiveToolOptions,
    request: PermissionRequest,
    reply: PermissionReply,
): { readonly reply: PermissionReply; readonly remember: boolean } {
    const normalizedReply = {
        ...reply,
        approvalId: reply.approvalId.length > 0 ? reply.approvalId : approvalIdFor(request),
    } satisfies PermissionReply;
    const redactor = options.observabilityRedactor ?? createObservabilityRedactor();
    const canRemember = JSON.stringify(redactor.redactValue(request)) === JSON.stringify(request);
    const effectiveReply: PermissionReply = canRemember
        ? normalizedReply
        : {
              approvalId: normalizedReply.approvalId,
              reply: normalizedReply.reply === 'deny' ? 'deny' : 'once',
              reason: 'credential-bearing approval applied once',
          };
    return { reply: effectiveReply, remember: canRemember };
}

export function deniedReply(request: PermissionRequest, reason: string): PermissionReply {
    return { approvalId: approvalIdFor(request), reply: 'deny', reason };
}

export function deniedDecision(request: PermissionRequest, reason: string): PermissionDecision {
    return { requestId: request.id, status: 'deny', reason };
}
