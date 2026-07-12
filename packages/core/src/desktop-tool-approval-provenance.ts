import type { AgentEvent, ApprovalRecord, ModelProviderSelection, ToolCall } from '@mission-control/protocol';
import {
    matchesApprovalRecord,
    matchesPermissionRequest,
    requestIdForToolCall,
    toolCallsFromEvents,
} from './desktop-tool-approval-events.js';

export function latestBlockedToolCallId(events: readonly AgentEvent[]): string | undefined {
    const latestRunEvent = [...events]
        .reverse()
        .find((event) => event.run?.state !== undefined && isRunStateEvent(event.type));
    if (latestRunEvent?.type !== 'run.blocked' || latestRunEvent.run?.state !== 'blocked_on_approval') {
        return undefined;
    }
    return latestRunEvent.run.toolCallId;
}

export function hasRuntimeOwnedPermissionRequest(events: readonly AgentEvent[], toolCall: ToolCall): boolean {
    return events.some((event) => matchesPermissionRequest(event, toolCall));
}

export function hasRuntimeOwnedCancelledApproval(events: readonly AgentEvent[], toolCall: ToolCall): boolean {
    const cancellationIndex = lastIndexWhere(
        events,
        (event) =>
            event.type === 'approval.blocked' && matchesApprovalRecord(event.approvalRecord, toolCall, 'cancelled'),
    );
    if (cancellationIndex < 0) {
        return false;
    }
    const requestedIndex = lastIndexWhere(
        events.slice(0, cancellationIndex),
        (event) =>
            event.type === 'approval.requested' && matchesApprovalRecord(event.approvalRecord, toolCall, 'pending'),
    );
    if (requestedIndex < 0) {
        return false;
    }
    if (
        events
            .slice(requestedIndex + 1, cancellationIndex)
            .some((event) => event.type === 'approval.updated' && matchesApprovalRecord(event.approvalRecord, toolCall))
    ) {
        return false;
    }
    const permissionIndex = lastIndexWhere(events.slice(0, requestedIndex), (event) =>
        matchesPermissionRequest(event, toolCall),
    );
    if (permissionIndex < 0) {
        return false;
    }
    return events
        .slice(cancellationIndex + 1)
        .some(
            (event) =>
                event.type === 'run.blocked' &&
                event.run?.state === 'blocked_on_approval' &&
                event.run.toolCallId === toolCall.toolCallId,
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

function lastIndexWhere<T>(values: readonly T[], predicate: (value: T) => boolean): number {
    for (let index = values.length - 1; index >= 0; index -= 1) {
        const value = values[index];
        if (value !== undefined && predicate(value)) {
            return index;
        }
    }
    return -1;
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
