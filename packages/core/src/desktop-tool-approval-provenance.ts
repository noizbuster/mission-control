import type { AgentEvent, ApprovalRecord, ModelProviderSelection, ToolCall } from '@mission-control/protocol';
import { requestIdForToolCall, toolCallsFromEvents } from './desktop-tool-approval-events.js';

export function latestBlockedToolCallId(events: readonly AgentEvent[]): string | undefined {
    const latestRunEvent = [...events]
        .reverse()
        .find((event) => event.run?.state !== undefined && isRunStateEvent(event.type));
    if (latestRunEvent?.type !== 'run.blocked' || latestRunEvent.run?.state !== 'blocked_on_approval') {
        return undefined;
    }
    return latestRunEvent.run.toolCallId;
}

export function hasRuntimeOwnedPermissionRequest(events: readonly AgentEvent[], requestId: string): boolean {
    return events.some(
        (event) =>
            event.type === 'permission.requested' &&
            event.permissionRequest?.id === requestId &&
            event.permissionDecision?.requestId === requestId,
    );
}

export function toolCallById(events: readonly AgentEvent[], toolCallId: string): ToolCall | undefined {
    return [...toolCallsFromEvents(events)].reverse().find((toolCall) => toolCall.toolCallId === toolCallId);
}

export function pendingApprovalRecord(toolCall: ToolCall, requestedAt: string): ApprovalRecord {
    return {
        approvalId: `approval_${requestIdForToolCall(toolCall.toolCallId)}`,
        requestId: requestIdForToolCall(toolCall.toolCallId),
        policyDecision: 'requires_approval',
        state: 'pending',
        subject: { kind: 'tool', id: toolCall.toolName },
        requestedAt,
        reason: `approve ${toolCall.toolName}`,
    };
}

export function permissionRequestedEvent(
    sessionId: string,
    modelProviderSelection: ModelProviderSelection,
    toolCall: ToolCall,
    now: () => string,
): AgentEvent {
    const requestId = requestIdForToolCall(toolCall.toolCallId);
    const reason = `approve ${toolCall.toolName}`;
    return {
        type: 'permission.requested',
        timestamp: now(),
        sessionId,
        message: `permission requested: ${toolCall.toolName}`,
        nativeSidecarStatus: 'mock',
        modelProviderSelection,
        permissionRequest: {
            id: requestId,
            action: toolCall.toolName,
            reason,
        },
        permissionDecision: {
            requestId,
            status: 'requires_approval',
            reason,
        },
    };
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
