import { defaultModelProviderSelection } from '@mission-control/config';
import type {
    AgentEvent,
    ApprovalRecord,
    ModelProviderSelection,
    PermissionDecision,
    PermissionRequest,
} from '@mission-control/protocol';
import type { ApprovalTerminalState } from './approval-gate.js';
import { type DesktopApprovalEffect, desktopApprovalEffect } from './desktop-approval-effect.js';
import { withDesktopApprovalSettlementLock } from './desktop-approval-settlement-lock.js';
import {
    approvalEvent,
    approvalIdForToolCall,
    decidedRecord,
    hasTerminalRunAfterApproval,
    latestApprovalRecord,
    type PendingApprovalContext,
    pendingApprovalContextForCurrentRun,
    sessionEvent,
    toolFailed,
} from './desktop-tool-approval-events.js';
import {
    blockedToolAuthority,
    hasRuntimeOwnedCancelledApproval,
    hasRuntimeOwnedPermissionRequest,
    pendingApprovalRecord,
    permissionRequestedEvent,
} from './desktop-tool-approval-provenance.js';
import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    registerCommandRunTool,
} from './tools/command-run.js';
import { registerFileEditTool } from './tools/file-edit.js';
import { registerFilePatchTool } from './tools/file-patch.js';
import { registerFileWriteTool } from './tools/file-write.js';
import { ToolRegistry } from './tools/tool-registry.js';

export type DesktopApprovalStore = {
    readonly append: (event: AgentEvent) => Promise<void>;
    readonly getEvents: (sessionId: string) => Promise<readonly AgentEvent[]>;
    readonly reserveDesktopApprovalEffect: (effect: DesktopApprovalEffect) => Promise<boolean>;
    readonly claimDesktopApprovalEffect: (effect: DesktopApprovalEffect) => Promise<boolean>;
};

export type DesktopApprovalDecisionInput = {
    readonly sessionId: string;
    readonly approvalId: string;
    readonly state: ApprovalTerminalState;
    readonly reason?: string;
};

export type DesktopApprovalSettlementOptions = {
    readonly store: DesktopApprovalStore;
    readonly sessionId: string;
    readonly workspaceRoot: string;
    readonly modelProviderSelection?: ModelProviderSelection;
    readonly now: () => string;
    readonly commandExecutor?: (request: CommandExecutionRequest) => Promise<CommandExecutionResult>;
};

export type DesktopApprovalSettlementStatus = 'completed' | 'blocked' | 'failed' | 'idle';

export async function ensurePendingToolApprovalForCurrentBlockedRun(input: {
    readonly store: DesktopApprovalStore;
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly now: () => string;
    readonly blockedToolCallId: string;
    readonly workspaceRoot: string;
}): Promise<void> {
    const approvalId = approvalIdForToolCall(input.blockedToolCallId);
    await withDesktopApprovalSettlementLock(input.store, { sessionId: input.sessionId, approvalId }, async () => {
        await ensurePendingToolApprovalForCurrentBlockedRunUnlocked(input);
    });
}

async function ensurePendingToolApprovalForCurrentBlockedRunUnlocked(input: {
    readonly store: DesktopApprovalStore;
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly now: () => string;
    readonly blockedToolCallId: string;
    readonly workspaceRoot: string;
}): Promise<void> {
    const events = await input.store.getEvents(input.sessionId);
    const authority = blockedToolAuthority(events);
    if (authority === undefined || authority.toolCall.toolCallId !== input.blockedToolCallId) {
        return;
    }
    const approvalId = approvalIdForToolCall(authority.toolCall.toolCallId);
    const latestApproval = latestApprovalRecord(events, approvalId);
    if (latestApproval !== undefined && latestApproval.state !== 'cancelled') {
        if (latestApproval.state !== 'pending') return;
    }
    const pendingApproval =
        latestApproval?.state === 'pending' ? pendingApprovalContextForCurrentRun(events, approvalId) : undefined;
    if (latestApproval?.state === 'pending' && pendingApproval === undefined) return;
    const toolCall = authority.toolCall;
    const currentRunStartIndex = authority.runStartEventIndex + 1;
    if (!hasRuntimeOwnedPermissionRequest(events, toolCall, currentRunStartIndex)) {
        return;
    }
    if (
        latestApproval?.state === 'cancelled' &&
        !hasRuntimeOwnedCancelledApproval(events, toolCall, currentRunStartIndex)
    ) {
        return;
    }
    const effect = desktopApprovalEffect({
        sessionId: input.sessionId,
        approvalId,
        runId: authority.runId,
        toolCall,
        workspaceRoot: input.workspaceRoot,
    });
    if (!(await input.store.reserveDesktopApprovalEffect(effect))) {
        return;
    }
    if (pendingApproval !== undefined) {
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

export async function ensureRuntimeOwnedPermissionRequestForBlockedToolCall(input: {
    readonly store: DesktopApprovalStore;
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly now: () => string;
    readonly blockedToolCallId: string;
}): Promise<void> {
    const approvalId = approvalIdForToolCall(input.blockedToolCallId);
    await withDesktopApprovalSettlementLock(input.store, { sessionId: input.sessionId, approvalId }, async () => {
        await ensureRuntimeOwnedPermissionRequestForBlockedToolCallUnlocked(input);
    });
}

async function ensureRuntimeOwnedPermissionRequestForBlockedToolCallUnlocked(input: {
    readonly store: DesktopApprovalStore;
    readonly sessionId: string;
    readonly modelProviderSelection: ModelProviderSelection;
    readonly now: () => string;
    readonly blockedToolCallId: string;
}): Promise<void> {
    const events = await input.store.getEvents(input.sessionId);
    const authority = blockedToolAuthority(events);
    if (authority === undefined || authority.toolCall.toolCallId !== input.blockedToolCallId) {
        return;
    }
    const toolCall = authority.toolCall;
    if (hasRuntimeOwnedPermissionRequest(events, toolCall, authority.runStartEventIndex + 1)) {
        return;
    }
    await input.store.append(
        permissionRequestedEvent(input.sessionId, input.modelProviderSelection, toolCall, input.now),
    );
}

export async function settleDesktopApproval(
    input: DesktopApprovalDecisionInput,
    options: DesktopApprovalSettlementOptions,
): Promise<DesktopApprovalSettlementStatus> {
    return withDesktopApprovalSettlementLock(options.store, input, () => settleDesktopApprovalUnlocked(input, options));
}

async function settleDesktopApprovalUnlocked(
    input: DesktopApprovalDecisionInput,
    options: DesktopApprovalSettlementOptions,
): Promise<DesktopApprovalSettlementStatus> {
    const events = await options.store.getEvents(input.sessionId);
    const pendingApproval = pendingApprovalContextForCurrentRun(events, input.approvalId);
    if (pendingApproval === undefined) {
        return 'idle';
    }
    const pending = pendingApproval.record;
    if (hasTerminalRunAfterApproval(events, pending.approvalId, pendingApproval.runId)) {
        return 'idle';
    }
    const effect = desktopApprovalEffect({
        sessionId: input.sessionId,
        approvalId: pending.approvalId,
        runId: pendingApproval.runId,
        toolCall: pendingApproval.toolCall,
        workspaceRoot: options.workspaceRoot,
    });
    if (!(await options.store.reserveDesktopApprovalEffect(effect))) {
        return 'idle';
    }
    if (!(await options.store.claimDesktopApprovalEffect(effect))) {
        return 'idle';
    }
    const modelProviderSelection = options.modelProviderSelection ?? defaultModelProviderSelection;
    const decided = decidedRecord(pending, input.state, options.now(), input.reason);
    await options.store.append(
        approvalEvent({
            type: 'approval.updated',
            sessionId: input.sessionId,
            modelProviderSelection,
            record: decided,
            message: `approval updated: ${input.state}`,
            now: options.now,
        }),
    );
    if (input.state !== 'approved') {
        await options.store.append(
            approvalEvent({
                type: 'approval.blocked',
                sessionId: input.sessionId,
                modelProviderSelection,
                record: decided,
                message: `approval blocked: ${input.state}`,
                now: options.now,
            }),
        );
        return 'blocked';
    }
    await options.store.append(
        approvalEvent({
            type: 'approval.resumed',
            sessionId: input.sessionId,
            modelProviderSelection,
            record: decided,
            message: 'approval resumed',
            now: options.now,
        }),
    );
    return invokeApprovedTool(pendingApproval.toolCall, decided, options, modelProviderSelection);
}

async function invokeApprovedTool(
    toolCall: PendingApprovalContext['toolCall'],
    record: PendingApprovalContext['record'],
    options: DesktopApprovalSettlementOptions,
    modelProviderSelection: ModelProviderSelection,
): Promise<DesktopApprovalSettlementStatus> {
    const registry = new ToolRegistry();
    await registerFileEditTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: permissionResolver(record),
    });
    await registerFileWriteTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: permissionResolver(record),
    });
    await registerFilePatchTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: permissionResolver(record),
    });
    await registerCommandRunTool(registry, {
        workspaceRoot: options.workspaceRoot,
        requestPermission: permissionResolver(record),
        requirePermissionForAllowlisted: true,
        ...(options.commandExecutor !== undefined ? { executor: options.commandExecutor } : {}),
    });
    const advertisement = registry.advertise().find((tool) => tool.name === toolCall.toolName);
    if (advertisement === undefined) {
        await options.store.append(
            toolFailed(options.sessionId, toolCall.toolCallId, `unknown tool: ${toolCall.toolName}`),
        );
        return 'failed';
    }
    const settlement = await registry.invoke({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        advertisedVersion: advertisement.version,
        argumentsJson: toolCall.argumentsJson,
    });
    for (const event of settlement.events) {
        await options.store.append(sessionEvent(event, options.sessionId, modelProviderSelection));
    }
    return settlement.result.status === 'completed' ? 'completed' : 'failed';
}

function permissionResolver(record: ApprovalRecord): (request: PermissionRequest) => PermissionDecision {
    return (request) => {
        if (record.subject.kind === 'tool' && request.id === record.requestId && request.action === record.subject.id) {
            return {
                requestId: request.id,
                status: 'allow',
                ...(record.reason !== undefined ? { reason: record.reason } : {}),
            };
        }
        return { requestId: request.id, status: 'deny', reason: 'desktop approval did not authorize this request' };
    };
}
