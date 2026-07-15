import type { AgentEvent, ModelProviderSelection, ToolCall } from '@mission-control/protocol';
import { desktopApprovalEffect } from './desktop-approval-effect';
import { withDesktopApprovalSettlementLock } from './desktop-approval-settlement-lock';
import {
    approvalEvent,
    approvalIdForToolCall,
    latestApprovalRecord,
    pendingApprovalContextForCurrentRun,
} from './desktop-tool-approval-events';
import {
    blockedToolAuthority,
    hasRuntimeOwnedCancelledApproval,
    hasRuntimeOwnedPermissionRequest,
    pendingApprovalRecord,
    permissionRequestedEvent,
} from './desktop-tool-approval-provenance';

export type DesktopApprovalBackfillStore = {
    readonly append: (event: AgentEvent) => Promise<void>;
    readonly getEvents: (sessionId: string) => Promise<readonly AgentEvent[]>;
    readonly getDesktopApprovalToolCall: (toolCallId: string) => Promise<ToolCall | undefined>;
    readonly reserveDesktopApprovalEffect: (effect: ReturnType<typeof desktopApprovalEffect>) => Promise<boolean>;
};

type PendingApprovalBackfillInput = {
    readonly store: DesktopApprovalBackfillStore;
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly now: () => string;
    readonly blockedToolCallId: string;
    readonly workspaceRoot: string;
};

type PermissionRequestBackfillInput = Omit<PendingApprovalBackfillInput, 'workspaceRoot'>;

export async function ensurePendingToolApprovalForCurrentBlockedRun(
    input: PendingApprovalBackfillInput,
): Promise<void> {
    const approvalId = approvalIdForToolCall(input.blockedToolCallId);
    await withDesktopApprovalSettlementLock(input.store, { sessionId: input.sessionId, approvalId }, async () => {
        await ensurePendingToolApprovalForCurrentBlockedRunUnlocked(input);
    });
}

async function ensurePendingToolApprovalForCurrentBlockedRunUnlocked(
    input: PendingApprovalBackfillInput,
): Promise<void> {
    const events = await input.store.getEvents(input.sessionId);
    const authority = blockedToolAuthority(events);
    if (authority === undefined || authority.toolCall.toolCallId !== input.blockedToolCallId) return;

    const approvalId = approvalIdForToolCall(authority.toolCall.toolCallId);
    const latestApproval = latestApprovalRecord(events, approvalId);
    if (latestApproval !== undefined && latestApproval.state !== 'cancelled' && latestApproval.state !== 'pending') {
        return;
    }
    const pendingApproval =
        latestApproval?.state === 'pending' ? pendingApprovalContextForCurrentRun(events, approvalId) : undefined;
    if (latestApproval?.state === 'pending' && pendingApproval === undefined) return;

    const toolCall = await input.store.getDesktopApprovalToolCall(authority.toolCall.toolCallId);
    if (toolCall === undefined || toolCall.toolName !== authority.toolCall.toolName) return;
    const currentRunStartIndex = authority.runStartEventIndex + 1;
    if (!hasRuntimeOwnedPermissionRequest(events, toolCall, currentRunStartIndex)) return;
    if (
        latestApproval?.state === 'cancelled' &&
        !hasRuntimeOwnedCancelledApproval(events, toolCall, currentRunStartIndex)
    ) {
        return;
    }
    if (
        !(await input.store.reserveDesktopApprovalEffect(
            desktopApprovalEffect({
                sessionId: input.sessionId,
                approvalId,
                runId: authority.runId,
                toolCall,
                workspaceRoot: input.workspaceRoot,
            }),
        )) ||
        pendingApproval !== undefined
    ) {
        return;
    }
    await input.store.append(
        approvalEvent({
            type: 'approval.requested',
            sessionId: input.sessionId,
            modelProviderSelection: input.modelProviderSelection,
            record: pendingApprovalRecord(toolCall, input.now()),
            message: `approval requested: ${toolCall.toolName}`,
            now: input.now,
        }),
    );
}

export async function ensureRuntimeOwnedPermissionRequestForBlockedToolCall(
    input: PermissionRequestBackfillInput,
): Promise<void> {
    const approvalId = approvalIdForToolCall(input.blockedToolCallId);
    await withDesktopApprovalSettlementLock(input.store, { sessionId: input.sessionId, approvalId }, async () => {
        const events = await input.store.getEvents(input.sessionId);
        const authority = blockedToolAuthority(events);
        if (authority === undefined || authority.toolCall.toolCallId !== input.blockedToolCallId) return;
        if (hasRuntimeOwnedPermissionRequest(events, authority.toolCall, authority.runStartEventIndex + 1)) return;
        await input.store.append(
            permissionRequestedEvent(input.sessionId, input.modelProviderSelection, authority.toolCall, input.now),
        );
    });
}
