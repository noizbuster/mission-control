import { defaultModelProviderSelection } from '@mission-control/config';
import type { AgentEvent, ApprovalRecord, ToolCall } from '@mission-control/protocol';
import { fixedNow } from './desktop-session-commands-test-support.js';
import type { DesktopApprovalSettlementOptions, DesktopApprovalStore } from './desktop-tool-approvals.js';

export type MemoryApprovalStore = DesktopApprovalStore & {
    readonly events: readonly AgentEvent[];
};

export function createMemoryApprovalStore(initialEvents: readonly AgentEvent[]): MemoryApprovalStore {
    const events: AgentEvent[] = [...initialEvents];
    return {
        events,
        append: async (event) => {
            events.push(event);
        },
        getEvents: async () => [...events],
    };
}

export function approvalDecision(sessionId: string, approvalId: string, reason: string) {
    return { sessionId, approvalId, state: 'approved' as const, reason };
}

export function approvalOptions(input: {
    readonly store: DesktopApprovalStore;
    readonly sessionId: string;
    readonly workspaceRoot: string;
    readonly commandExecutor?: NonNullable<DesktopApprovalSettlementOptions['commandExecutor']>;
}): DesktopApprovalSettlementOptions {
    return {
        store: input.store,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        modelProviderSelection: defaultModelProviderSelection,
        now: fixedNow,
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

export function runBlockedEvent(sessionId: string, toolCallId: string): AgentEvent {
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
            runId: `run_${toolCallId}`,
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

export type Deferred<T> = {
    readonly promise: Promise<T>;
    readonly resolve: (value: T | PromiseLike<T>) => void;
    readonly reject: (reason?: unknown) => void;
};

export function createDeferred<T>(): Deferred<T> {
    let resolve: Deferred<T>['resolve'] | undefined;
    let reject: Deferred<T>['reject'] | undefined;
    const promise = new Promise<T>((promiseResolve, promiseReject) => {
        resolve = promiseResolve;
        reject = promiseReject;
    });
    if (resolve === undefined || reject === undefined) {
        throw new Error('deferred initialization failed');
    }
    return { promise, resolve, reject };
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
