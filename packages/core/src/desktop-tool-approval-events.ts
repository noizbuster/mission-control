import type { AgentEvent, ApprovalRecord, ModelProviderSelection, ToolCall } from '@mission-control/protocol';

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

export function pendingRecord(toolCall: ToolCall, requestedAt: string): ApprovalRecord {
    const requestId = requestIdForToolCall(toolCall.toolCallId);
    return {
        approvalId: approvalIdForToolCall(toolCall.toolCallId),
        requestId,
        policyDecision: 'requires_approval',
        state: 'pending',
        subject: { kind: 'tool', id: toolCall.toolName },
        requestedAt,
        reason: `approve ${toolCall.toolName}`,
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

export function toolCallsFromEvents(events: readonly AgentEvent[]): readonly ToolCall[] {
    return events.flatMap((event) => {
        const chunk = event.providerStreamChunk;
        return chunk?.kind === 'tool_call_completed' ? [chunk.toolCall] : [];
    });
}

export function toolCallForApproval(events: readonly AgentEvent[], approvalId: string): ToolCall | undefined {
    return [...toolCallsFromEvents(events)]
        .reverse()
        .find((toolCall) => approvalIdForToolCall(toolCall.toolCallId) === approvalId);
}

export function latestApprovalRecord(events: readonly AgentEvent[], approvalId: string): ApprovalRecord | undefined {
    return [...events].reverse().find((event) => event.approvalRecord?.approvalId === approvalId)?.approvalRecord;
}

export function approvalIdFromEvent(event: AgentEvent): readonly string[] {
    return event.approvalRecord === undefined ? [] : [event.approvalRecord.approvalId];
}

export function hasTerminalRunAfterApproval(events: readonly AgentEvent[], approvalId: string): boolean {
    let sawRequestedApproval = false;
    for (const event of events) {
        if (event.approvalRecord?.approvalId === approvalId && event.approvalRecord.state === 'pending') {
            sawRequestedApproval = true;
            continue;
        }
        if (sawRequestedApproval && isTerminalRunEvent(event.type)) {
            return true;
        }
    }
    return false;
}

export function approvalIdForToolCall(toolCallId: string): string {
    return `approval_${requestIdForToolCall(toolCallId)}`;
}

function requestIdForToolCall(toolCallId: string): string {
    return `permission_${toolCallId}`;
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
