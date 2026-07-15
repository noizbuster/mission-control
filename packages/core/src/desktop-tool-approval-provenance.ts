import type { AgentEvent, ApprovalRecord, ModelProviderSelection, ToolCall } from '@mission-control/protocol';

export { currentBlockedToolAuthority as blockedToolAuthority } from './desktop-tool-approval-authority';

import {
    matchesApprovalRecord,
    matchesPermissionRequest,
    requestIdForToolCall,
} from './desktop-tool-approval-events';

export function hasRuntimeOwnedPermissionRequest(
    events: readonly AgentEvent[],
    toolCall: ToolCall,
    inclusiveStartIndex = 0,
): boolean {
    return events.slice(inclusiveStartIndex).some((event) => matchesPermissionRequest(event, toolCall));
}

export function hasRuntimeOwnedCancelledApproval(
    events: readonly AgentEvent[],
    toolCall: ToolCall,
    inclusiveStartIndex = 0,
): boolean {
    const scopedEvents = events.slice(inclusiveStartIndex);
    const cancellationIndex = lastIndexWhere(
        scopedEvents,
        (event) =>
            event.type === 'approval.blocked' && matchesApprovalRecord(event.approvalRecord, toolCall, 'cancelled'),
    );
    if (cancellationIndex < 0) {
        return false;
    }
    const requestedIndex = lastIndexWhere(
        scopedEvents.slice(0, cancellationIndex),
        (event) =>
            event.type === 'approval.requested' && matchesApprovalRecord(event.approvalRecord, toolCall, 'pending'),
    );
    if (requestedIndex < 0) {
        return false;
    }
    if (
        scopedEvents
            .slice(requestedIndex + 1, cancellationIndex)
            .some((event) => event.type === 'approval.updated' && matchesApprovalRecord(event.approvalRecord, toolCall))
    ) {
        return false;
    }
    const permissionIndex = lastIndexWhere(scopedEvents.slice(0, requestedIndex), (event) =>
        matchesPermissionRequest(event, toolCall),
    );
    if (permissionIndex < 0) {
        return false;
    }
    return scopedEvents
        .slice(cancellationIndex + 1)
        .some(
            (event) =>
                event.type === 'run.blocked' &&
                event.run?.state === 'blocked_on_approval' &&
                event.run.toolCallId === toolCall.toolCallId,
        );
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
