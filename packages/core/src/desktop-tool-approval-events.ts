import type { AgentEvent, ApprovalRecord, ModelProviderSelection, ToolCall } from '@mission-control/protocol';

export type PendingApprovalContext = {
    readonly record: ApprovalRecord;
    readonly toolCall: ToolCall;
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

export function toolCallsFromEvents(events: readonly AgentEvent[]): readonly ToolCall[] {
    return events.flatMap((event) => {
        const fromFlat = toolCallsFromFlatProviderChunk(event);
        return fromFlat.length > 0 ? fromFlat : toolCallsFromGraphEmit(event);
    });
}

function toolCallsFromFlatProviderChunk(event: AgentEvent): readonly ToolCall[] {
    const chunk = event.providerStreamChunk;
    return chunk?.kind === 'tool_call_completed' ? [chunk.toolCall] : [];
}

/**
 * Graph-engine parity for `toolCallsFromFlatProviderChunk`. The flat path records a tool call as
 * `providerStreamChunk.toolCall` on `model.call.completed`; the ABG graph records the same proposal
 * as an `abg.emit.type === 'llm.tool_call.proposed'` payload on a `log` event, with the parsed
 * `input` object that we JSON-stringify back into `argumentsJson`. Narrowed `in`/`typeof` (no casts).
 */
function toolCallsFromGraphEmit(event: AgentEvent): readonly ToolCall[] {
    const emit = event.abg?.emit;
    if (emit === undefined || emit.type !== 'llm.tool_call.proposed') {
        return [];
    }
    const payload = emit.payload;
    if (typeof payload !== 'object' || payload === null) {
        return [];
    }
    if (!('toolCallId' in payload) || typeof payload.toolCallId !== 'string') {
        return [];
    }
    if (!('toolName' in payload) || typeof payload.toolName !== 'string') {
        return [];
    }
    const toolCallId = payload.toolCallId;
    const toolName = payload.toolName;
    const input = 'input' in payload ? payload.input : undefined;
    return [
        {
            toolCallId,
            toolName,
            argumentsJson: JSON.stringify(input ?? {}),
        },
    ];
}

export function pendingApprovalContextForCurrentRun(
    events: readonly AgentEvent[],
    approvalId: string,
): PendingApprovalContext | undefined {
    const record = latestApprovalRecord(events, approvalId);
    if (record?.state !== 'pending') {
        return undefined;
    }
    const currentBlockedToolCallId = latestBlockedToolCallId(events);
    if (currentBlockedToolCallId === undefined) {
        return undefined;
    }
    const toolCallId = toolCallIdForRequestId(record.requestId);
    if (toolCallId === undefined || toolCallId !== currentBlockedToolCallId) {
        return undefined;
    }
    if (!hasRuntimeOwnedPermissionRequest(events, record.requestId)) {
        return undefined;
    }
    if (!hasRuntimeOwnedApprovalRequest(events, record.approvalId, record.requestId)) {
        return undefined;
    }
    const toolCall = toolCallById(events, toolCallId);
    if (toolCall === undefined) {
        return undefined;
    }
    return { record, toolCall };
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

export function requestIdForToolCall(toolCallId: string): string {
    return `permission_${toolCallId}`;
}

function toolCallById(events: readonly AgentEvent[], toolCallId: string): ToolCall | undefined {
    return [...toolCallsFromEvents(events)].reverse().find((toolCall) => toolCall.toolCallId === toolCallId);
}

function latestBlockedToolCallId(events: readonly AgentEvent[]): string | undefined {
    const latestRunEvent = [...events]
        .reverse()
        .find((event) => event.run?.state !== undefined && isRunStateEvent(event.type));
    if (latestRunEvent?.type !== 'run.blocked' || latestRunEvent.run?.state !== 'blocked_on_approval') {
        return undefined;
    }
    return latestRunEvent.run.toolCallId;
}

function hasRuntimeOwnedPermissionRequest(events: readonly AgentEvent[], requestId: string): boolean {
    return events.some(
        (event) =>
            event.type === 'permission.requested' &&
            event.permissionRequest?.id === requestId &&
            event.permissionDecision?.requestId === requestId,
    );
}

function hasRuntimeOwnedApprovalRequest(events: readonly AgentEvent[], approvalId: string, requestId: string): boolean {
    return events.some((event) => {
        return (
            event.type === 'approval.requested' &&
            event.approvalRecord?.approvalId === approvalId &&
            event.approvalRecord.requestId === requestId
        );
    });
}

function toolCallIdForRequestId(requestId: string): string | undefined {
    return requestId.startsWith('permission_') ? requestId.slice('permission_'.length) : undefined;
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

function isRunStateEvent(type: AgentEvent['type']): boolean {
    switch (type) {
        case 'run.started':
        case 'run.completed':
        case 'run.interrupted':
        case 'run.failed':
        case 'run.blocked':
        case 'run.idle':
            return true;
        default:
            return false;
    }
}
