import { defaultModelProviderSelection } from '@mission-control/config';
import type { AgentEvent, ApprovalRecord, ToolCall } from '@mission-control/protocol';
import { fixedNow } from './desktop-session-commands-test-support';
import type { DesktopApprovalSettlementOptions, DesktopApprovalStore } from './desktop-tool-approvals';

export { createDeferred, type Deferred } from './desktop-tool-approval-async-test-support';
export {
    createMemoryApprovalStore,
    type MemoryApprovalStore,
} from './desktop-tool-approval-memory-store-test-support';

export function approvalDecision(sessionId: string, approvalId: string, reason: string) {
    return { sessionId, approvalId, state: 'approved' as const, reason };
}

export function approvalOptions(input: {
    readonly store: DesktopApprovalStore;
    readonly sessionId: string;
    readonly workspaceRoot: string;
    readonly now?: () => string;
    readonly executionLeaseMs?: number;
    readonly commandExecutor?: NonNullable<DesktopApprovalSettlementOptions['commandExecutor']>;
}): DesktopApprovalSettlementOptions {
    return {
        store: input.store,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        modelProviderSelection: defaultModelProviderSelection,
        now: input.now ?? fixedNow,
        ...(input.executionLeaseMs !== undefined ? { executionLeaseMs: input.executionLeaseMs } : {}),
        ...(input.commandExecutor !== undefined ? { commandExecutor: input.commandExecutor } : {}),
    };
}

export function commandToolCall(toolCallId: string): ToolCall {
    return {
        toolCallId,
        toolName: 'command.run',
        argumentsJson: JSON.stringify({
            command: 'node',
            args: ['--eval', "console.log('mission-control command.run harness ok')"],
        }),
    };
}

export function filePatchToolCall(toolCallId: string, filePath: string, content: string): ToolCall {
    return {
        toolCallId,
        toolName: 'file.patch',
        argumentsJson: JSON.stringify({
            patch: [
                `diff --git a/${filePath} b/${filePath}`,
                '--- /dev/null',
                `+++ b/${filePath}`,
                '@@ -0,0 +1 @@',
                `+${content}`,
                '',
            ].join('\n'),
        }),
    };
}

export function fileEditToolCall(toolCallId: string, filePath: string, oldText: string, newText: string): ToolCall {
    return {
        toolCallId,
        toolName: 'file.edit',
        argumentsJson: JSON.stringify({ path: filePath, oldText, newText }),
    };
}

export function fileWriteToolCall(
    toolCallId: string,
    filePath: string,
    content: string,
    createParents: boolean,
): ToolCall {
    return {
        toolCallId,
        toolName: 'file.write',
        argumentsJson: JSON.stringify({ path: filePath, content, createParents }),
    };
}

export function providerToolCallEvent(sessionId: string, toolCall: ToolCall): AgentEvent {
    return {
        type: 'model.call.completed',
        timestamp: fixedNow(),
        sessionId,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: defaultModelProviderSelection,
        providerStreamChunk: {
            kind: 'tool_call_completed',
            requestId: 'request_test',
            sequence: 1,
            toolCall,
        },
    };
}

export function permissionRequestedEvent(sessionId: string, toolCall: ToolCall): AgentEvent {
    return {
        type: 'permission.requested',
        timestamp: fixedNow(),
        sessionId,
        message: `permission requested: ${toolCall.toolName}`,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: defaultModelProviderSelection,
        permissionRequest: {
            id: `permission_${toolCall.toolCallId}`,
            action: toolCall.toolName,
            reason: `approve ${toolCall.toolName}`,
        },
        permissionDecision: {
            requestId: `permission_${toolCall.toolCallId}`,
            status: 'requires_approval',
            reason: 'approval required',
        },
    };
}

export function approvalRequestedEvent(sessionId: string, toolCall: ToolCall): AgentEvent {
    return {
        type: 'approval.requested',
        timestamp: fixedNow(),
        sessionId,
        message: `approval requested: ${toolCall.toolName}`,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: defaultModelProviderSelection,
        approvalRecord: approvalRecord(toolCall),
    };
}

export function approvalBlockedCancelledEvent(sessionId: string, toolCall: ToolCall): AgentEvent {
    return {
        type: 'approval.blocked',
        timestamp: fixedNow(),
        sessionId,
        message: `approval blocked: ${toolCall.toolName}`,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: defaultModelProviderSelection,
        approvalRecord: {
            ...approvalRecord(toolCall),
            state: 'cancelled',
            decidedAt: fixedNow(),
        },
    };
}

export function approvalUpdatedEvent(
    sessionId: string,
    toolCall: ToolCall,
    state: 'approved' | 'denied' | 'cancelled',
): AgentEvent {
    return {
        type: 'approval.updated',
        timestamp: fixedNow(),
        sessionId,
        message: `approval updated: ${toolCall.toolName}`,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: defaultModelProviderSelection,
        approvalRecord: {
            ...approvalRecord(toolCall),
            state,
            decidedAt: fixedNow(),
        },
    };
}

export function runStartedEvent(sessionId: string, runId: string): AgentEvent {
    return {
        type: 'run.started',
        timestamp: fixedNow(),
        sessionId,
        message: 'run started',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: defaultModelProviderSelection,
        run: { command: 'run', state: 'running', runId },
    };
}

export function runBlockedEvent(sessionId: string, toolCallId: string, runId = `run_${toolCallId}`): AgentEvent {
    return {
        type: 'run.blocked',
        timestamp: fixedNow(),
        sessionId,
        message: 'waiting for approval',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: defaultModelProviderSelection,
        run: {
            command: 'run',
            state: 'blocked_on_approval',
            runId,
            reason: 'waiting for approval',
            toolCallId,
        },
    };
}

export function runFailedEvent(sessionId: string): AgentEvent {
    return {
        type: 'run.failed',
        timestamp: fixedNow(),
        sessionId,
        message: 'run failed after approval request',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: defaultModelProviderSelection,
        run: { command: 'run', state: 'failed', runId: 'run_failed_after_approval_request', reason: 'provider failed' },
    };
}

export function runCompletedEvent(sessionId: string, runId: string): AgentEvent {
    return {
        type: 'run.completed',
        timestamp: fixedNow(),
        sessionId,
        message: 'run completed before a delayed blocked event',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: defaultModelProviderSelection,
        run: { command: 'run', state: 'completed', runId },
    };
}

export function completedCommandResult() {
    return {
        exitCode: 0,
        signal: null,
        stdout: 'desktop duplicate approval command ok\n',
        stderr: '',
        timedOut: false,
        durationMs: 1,
    };
}

export function countEvents(events: readonly AgentEvent[], type: AgentEvent['type']): number {
    return events.filter((event) => event.type === type).length;
}

function approvalRecord(toolCall: ToolCall): ApprovalRecord {
    return {
        approvalId: `approval_permission_${toolCall.toolCallId}`,
        requestId: `permission_${toolCall.toolCallId}`,
        policyDecision: 'requires_approval',
        state: 'pending',
        subject: { kind: 'tool', id: toolCall.toolName },
        requestedAt: fixedNow(),
        reason: `approve ${toolCall.toolName}`,
    };
}
