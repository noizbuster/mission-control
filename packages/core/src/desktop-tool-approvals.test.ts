import { defaultModelProviderSelection } from '@mission-control/config';
import type { AgentEvent, ApprovalRecord, ToolCall } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { settleDesktopApproval, type DesktopApprovalStore } from './desktop-tool-approvals.js';
import { fixedNow } from './desktop-session-commands-test-support.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('desktop tool approvals', () => {
    it('does not execute duplicate approval twice', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-approval-race-workspace-'));
        const sessionId = 'session_desktop_approval_race';
        const toolCall = commandToolCall('call_duplicate_approval');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
        ]);
        let commandExecutions = 0;

        try {
            const first = settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_call_duplicate_approval', 'first click'),
                approvalOptions({
                    store,
                    sessionId,
                    workspaceRoot,
                    commandExecutor: async () => {
                        commandExecutions += 1;
                        await new Promise((resolve) => {
                            setTimeout(resolve, 25);
                        });
                        return completedCommandResult();
                    },
                }),
            );
            const second = settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_call_duplicate_approval', 'second click'),
                approvalOptions({
                    store,
                    sessionId,
                    workspaceRoot,
                    commandExecutor: async () => {
                        commandExecutions += 1;
                        return completedCommandResult();
                    },
                }),
            );
            const statuses = await Promise.all([first, second]);

            expect(statuses).toEqual(expect.arrayContaining(['completed', 'idle']));
            expect(commandExecutions).toBe(1);
            expect(countEvents(store.events, 'command.completed')).toBe(1);
            expect(countEvents(store.events, 'tool.completed')).toBe(1);
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('refuses approval decisions after run failure', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-approval-failed-workspace-'));
        const sessionId = 'session_desktop_approval_failed';
        const toolCall = filePatchToolCall('call_after_failure', '.mission-control-after-failure.txt', 'must not write');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
            runFailedEvent(sessionId),
        ]);

        try {
            const status = await settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_call_after_failure', 'late click'),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );

            expect(status).toBe('idle');
            expect(countEvents(store.events, 'file.diff.applied')).toBe(0);
            await expect(readFile(join(workspaceRoot, '.mission-control-after-failure.txt'), 'utf8')).rejects.toThrow();
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('does not apply duplicate file patch approval twice', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-patch-race-workspace-'));
        const sessionId = 'session_desktop_patch_race';
        const targetPath = '.mission-control-duplicate-patch.txt';
        const toolCall = filePatchToolCall('call_duplicate_patch', targetPath, 'one write');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
        ]);

        try {
            const statuses = await Promise.all([
                settleDesktopApproval(
                    approvalDecision(sessionId, 'approval_permission_call_duplicate_patch', 'first click'),
                    approvalOptions({ store, sessionId, workspaceRoot }),
                ),
                settleDesktopApproval(
                    approvalDecision(sessionId, 'approval_permission_call_duplicate_patch', 'second click'),
                    approvalOptions({ store, sessionId, workspaceRoot }),
                ),
            ]);

            expect(statuses).toEqual(expect.arrayContaining(['completed', 'idle']));
            expect(countEvents(store.events, 'file.diff.applied')).toBe(1);
            expect(await readFile(join(workspaceRoot, targetPath), 'utf8')).toBe('one write\n');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('ignores resume requests when no approval is pending', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-resume-idle-'));
        const sessionId = 'session_desktop_resume_idle';
        const store = createMemoryApprovalStore([]);

        try {
            const status = await settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_missing', 'stale resume'),
                approvalOptions({ store, sessionId, workspaceRoot: dataDir }),
            );

            expect(status).toBe('idle');
            expect(store.events).toHaveLength(0);
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });
});

type MemoryApprovalStore = DesktopApprovalStore & {
    readonly events: readonly AgentEvent[];
};

function createMemoryApprovalStore(initialEvents: readonly AgentEvent[]): MemoryApprovalStore {
    const events: AgentEvent[] = [...initialEvents];
    return {
        events,
        append: async (event) => {
            events.push(event);
        },
        getEvents: async () => [...events],
    };
}

function approvalDecision(sessionId: string, approvalId: string, reason: string) {
    return { sessionId, approvalId, state: 'approved' as const, reason };
}

function approvalOptions(input: {
    readonly store: DesktopApprovalStore;
    readonly sessionId: string;
    readonly workspaceRoot: string;
    readonly commandExecutor?: NonNullable<Parameters<typeof settleDesktopApproval>[1]['commandExecutor']>;
}): Parameters<typeof settleDesktopApproval>[1] {
    return {
        store: input.store,
        sessionId: input.sessionId,
        workspaceRoot: input.workspaceRoot,
        modelProviderSelection: defaultModelProviderSelection,
        now: fixedNow,
        ...(input.commandExecutor !== undefined ? { commandExecutor: input.commandExecutor } : {}),
    };
}

function commandToolCall(toolCallId: string): ToolCall {
    return {
        toolCallId,
        toolName: 'command.run',
        argumentsJson: JSON.stringify({
            command: 'node',
            args: ['--eval', "console.log('mission-control command.run harness ok')"],
        }),
    };
}

function filePatchToolCall(toolCallId: string, filePath: string, content: string): ToolCall {
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

function providerToolCallEvent(sessionId: string, toolCall: ToolCall): AgentEvent {
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

function approvalRequestedEvent(sessionId: string, toolCall: ToolCall): AgentEvent {
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

function runFailedEvent(sessionId: string): AgentEvent {
    return {
        type: 'run.failed',
        timestamp: fixedNow(),
        sessionId,
        message: 'run failed after approval request',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: defaultModelProviderSelection,
        run: {
            command: 'run',
            state: 'failed',
            runId: 'run_failed_after_approval_request',
            reason: 'provider failed',
        },
    };
}

function completedCommandResult() {
    return {
        exitCode: 0,
        signal: null,
        stdout: 'desktop duplicate approval command ok\n',
        stderr: '',
        timedOut: false,
        durationMs: 1,
    };
}

function countEvents(events: readonly AgentEvent[], type: AgentEvent['type']): number {
    return events.filter((event) => event.type === type).length;
}
