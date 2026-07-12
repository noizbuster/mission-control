import type { AgentEvent, ApprovalRecord, ModelProviderSelection, ToolCall } from '@mission-control/protocol';
import { currentBlockedToolAuthority, findToolCallBefore } from './desktop-tool-approval-authority.js';

export type PendingApprovalContext = {
    readonly record: ApprovalRecord;
    readonly toolCall: ToolCall;
    readonly runId: string;
};

export function approvalEvent(input: {
    readonly type: 'approval.requested' | 'approval.updated' | 'approval.blocked' | 'approval.resumed';
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly record: ApprovalRecord;
    readonly message: string;
    readonly now: () => string;
}): AgentEvent {
    return {
        type: input.type,
        timestamp: input.now(),
        sessionId: input.sessionId,
        message: input.message,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: input.modelProviderSelection,
        approvalRecord: input.record,
    };
}

export function decidedRecord(
    record: ApprovalRecord,
    state: ApprovalRecord['state'],
    decidedAt: string,
    reason: string | undefined,
): ApprovalRecord {
    return {
        ...record,
        state,
        decidedAt,
        reason: reason ?? record.reason,
    };
}

export function sessionEvent(
    event: AgentEvent,
    sessionId: string,
    modelProviderSelection: ModelProviderSelection,
): AgentEvent {
    return {
        ...event,
        sessionId,
        modelProviderSelection: event.modelProviderSelection ?? modelProviderSelection,
    };
}

export function toolFailed(sessionId: string, toolCallId: string, message: string): AgentEvent {
    return {
        type: 'tool.failed',
        timestamp: new Date().toISOString(),
        sessionId,
        taskId: toolCallId,
        message,
        nativeSidecarStatus: 'mock',
    };
}

export function pendingApprovalContextForCurrentRun(
    events: readonly AgentEvent[],
    approvalId: string,
): PendingApprovalContext | undefined {
    const latestApprovalIndex = lastIndexWhere(events, (event) => event.approvalRecord?.approvalId === approvalId);
    const latestApprovalEvent = events[latestApprovalIndex];
    const record = latestApprovalEvent?.approvalRecord;
    if (latestApprovalEvent?.type !== 'approval.requested' || record?.state !== 'pending') {
        return undefined;
    }
    const authority = currentBlockedToolAuthority(events);
    if (authority === undefined) {
        return undefined;
    }
    const approvedProposal = findToolCallBefore(events, latestApprovalIndex, authority.toolCall.toolCallId);
    if (approvedProposal === undefined || !sameToolCall(approvedProposal.toolCall, authority.toolCall)) {
        return undefined;
    }
    if (!matchesApprovalRecord(record, authority.toolCall, 'pending')) {
        return undefined;
    }
    if (!events.some((event) => matchesPermissionRequest(event, authority.toolCall))) {
        return undefined;
    }
    if (
        !events.some(
            (event) =>
                event.type === 'approval.requested' &&
                matchesApprovalRecord(event.approvalRecord, authority.toolCall, 'pending'),
        )
    ) {
        return undefined;
    }
    return { record, toolCall: authority.toolCall, runId: authority.runId };
}

export function matchesPermissionRequest(event: AgentEvent, toolCall: ToolCall): boolean {
    const requestId = requestIdForToolCall(toolCall.toolCallId);
    return (
        event.type === 'permission.requested' &&
        event.permissionRequest?.id === requestId &&
        event.permissionRequest.action === toolCall.toolName &&
        event.permissionDecision?.requestId === requestId &&
        event.permissionDecision.status === 'requires_approval'
    );
}

export function matchesApprovalRecord(
    record: ApprovalRecord | undefined,
    toolCall: ToolCall,
    state?: ApprovalRecord['state'],
): boolean {
    const requestId = requestIdForToolCall(toolCall.toolCallId);
    return (
        record?.approvalId === `approval_${requestId}` &&
        record.requestId === requestId &&
        record.policyDecision === 'requires_approval' &&
        (state === undefined || record.state === state) &&
        record.subject.kind === 'tool' &&
        record.subject.id === toolCall.toolName
    );
}

export function latestApprovalRecord(events: readonly AgentEvent[], approvalId: string): ApprovalRecord | undefined {
    return [...events].reverse().find((event) => event.approvalRecord?.approvalId === approvalId)?.approvalRecord;
}

export function approvalIdFromEvent(event: AgentEvent): readonly string[] {
    return event.approvalRecord === undefined ? [] : [event.approvalRecord.approvalId];
}

export function hasTerminalRunAfterApproval(events: readonly AgentEvent[], approvalId: string, runId: string): boolean {
    let sawRequestedApproval = false;
    for (const event of events) {
        if (event.approvalRecord?.approvalId === approvalId && event.approvalRecord.state === 'pending') {
            sawRequestedApproval = true;
            continue;
        }
        if (sawRequestedApproval && event.run?.runId === runId && isTerminalRunEvent(event.type)) {
            return true;
        }
    }
    return false;
}

export function approvalIdForToolCall(toolCallId: string): string {
    return `approval_${requestIdForToolCall(toolCallId)}`;
}

export function requestIdForToolCall(toolCallId: string): string {
    return `permission_${toolCallId}`;
}

function sameToolCall(left: ToolCall, right: ToolCall): boolean {
    return (
        left.toolCallId === right.toolCallId &&
        left.toolName === right.toolName &&
        left.argumentsJson === right.argumentsJson
    );
}

function lastIndexWhere<T>(values: readonly T[], predicate: (value: T) => boolean): number {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const value = values[index];
        if (value !== undefined && predicate(value)) return index;
    }
    return -1;
}

function isTerminalRunEvent(type: AgentEvent['type']): boolean {
    switch (type) {
        case 'run.completed':
        case 'run.failed':
        case 'run.interrupted':
            return true;
        default:
            return false;
    }
}
