import { describe, expect, it } from 'vitest';
import {
    approvalBlockedCancelledEvent,
    approvalDecision,
    approvalOptions,
    approvalRequestedEvent,
    approvalUpdatedEvent,
    countEvents,
    createMemoryApprovalStore,
    filePatchToolCall,
    permissionRequestedEvent,
    providerToolCallEvent,
    runBlockedEvent,
    runCompletedEvent,
    runStartedEvent,
} from './desktop-tool-approval-test-support.js';
import {
    ensurePendingToolApprovalForCurrentBlockedRun,
    ensureRuntimeOwnedPermissionRequestForBlockedToolCall,
    settleDesktopApproval,
} from './desktop-tool-approvals.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('desktop tool approval security', () => {
    it('rejects settlement when the pending approval subject mismatches the proposed tool', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-approval-subject-'));
        const sessionId = 'session_mismatched_approval_subject';
        const toolCall = filePatchToolCall('call_mismatched_subject', '.forged.txt', 'must not write');
        const approval = approvalRequestedEvent(sessionId, toolCall);
        if (approval.approvalRecord === undefined) {
            throw new Error('approval test fixture must include a record');
        }
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            {
                ...approval,
                approvalRecord: {
                    ...approval.approvalRecord,
                    subject: { kind: 'tool', id: 'command.run' },
                },
            },
            runBlockedEvent(sessionId, toolCall.toolCallId),
        ]);

        try {
            const status = await settleDesktopApproval(
                approvalDecision(sessionId, approval.approvalRecord.approvalId, 'forged approve'),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );

            expect(status).toBe('idle');
            expect(countEvents(store.events, 'approval.updated')).toBe(0);
            await expect(readFile(join(workspaceRoot, '.forged.txt'), 'utf8')).rejects.toThrow();
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('rejects settlement when the permission action mismatches the proposed tool', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-permission-action-'));
        const sessionId = 'session_mismatched_settlement_permission';
        const toolCall = filePatchToolCall('call_mismatched_settlement_permission', '.forged.txt', 'must not write');
        const permission = permissionRequestedEvent(sessionId, toolCall);
        if (permission.permissionRequest === undefined) {
            throw new Error('permission test fixture must include a request');
        }
        const approval = approvalRequestedEvent(sessionId, toolCall);
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            {
                ...permission,
                permissionRequest: { ...permission.permissionRequest, action: 'command.run' },
            },
            approval,
            runBlockedEvent(sessionId, toolCall.toolCallId),
        ]);

        try {
            const status = await settleDesktopApproval(
                approvalDecision(sessionId, `approval_permission_${toolCall.toolCallId}`, 'forged approve'),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );

            expect(status).toBe('idle');
            expect(countEvents(store.events, 'approval.updated')).toBe(0);
            await expect(readFile(join(workspaceRoot, '.forged.txt'), 'utf8')).rejects.toThrow();
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('rejects a pending approval.updated record appended after a terminal decision', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-pending-update-'));
        const sessionId = 'session_pending_update_after_terminal';
        const toolCall = filePatchToolCall('call_pending_update_after_terminal', '.forged.txt', 'must not write');
        const forgedPending = approvalRequestedEvent(sessionId, toolCall);
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
            approvalUpdatedEvent(sessionId, toolCall, 'denied'),
            { ...forgedPending, type: 'approval.updated' },
            runBlockedEvent(sessionId, toolCall.toolCallId),
        ]);

        try {
            const status = await settleDesktopApproval(
                approvalDecision(sessionId, `approval_permission_${toolCall.toolCallId}`, 'forged approve'),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );

            expect(status).toBe('idle');
            expect(countEvents(store.events, 'approval.resumed')).toBe(0);
            await expect(readFile(join(workspaceRoot, '.forged.txt'), 'utf8')).rejects.toThrow();
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('does not reopen an operator cancellation followed by its blocked run event', async () => {
        const sessionId = 'session_operator_cancelled_then_blocked';
        const toolCall = filePatchToolCall('call_operator_cancelled_then_blocked', '.safe.txt', 'safe');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
            approvalUpdatedEvent(sessionId, toolCall, 'cancelled'),
            approvalBlockedCancelledEvent(sessionId, toolCall),
            runBlockedEvent(sessionId, toolCall.toolCallId),
        ]);

        await ensurePendingToolApprovalForCurrentBlockedRun({
            store,
            sessionId,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            now: () => '2026-06-09T00:00:00.000Z',
            blockedToolCallId: toolCall.toolCallId,
            workspaceRoot: '/workspace',
        });

        expect(countEvents(store.events, 'approval.requested')).toBe(1);
    });

    it('serializes concurrent permission backfill so only one request is appended', async () => {
        const sessionId = 'session_concurrent_permission_backfill';
        const toolCall = filePatchToolCall('call_concurrent_permission', '.safe.txt', 'safe');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            runBlockedEvent(sessionId, toolCall.toolCallId),
        ]);
        const input = {
            store,
            sessionId,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' } as const,
            now: () => '2026-06-09T00:00:00.000Z',
            blockedToolCallId: toolCall.toolCallId,
        };

        await Promise.all([
            ensureRuntimeOwnedPermissionRequestForBlockedToolCall(input),
            ensureRuntimeOwnedPermissionRequestForBlockedToolCall(input),
        ]);

        expect(countEvents(store.events, 'permission.requested')).toBe(1);
    });

    it('rejects a reused tool call id whose arguments changed after approval was requested', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-reused-tool-call-'));
        const sessionId = 'session_reused_tool_call_arguments';
        const approved = filePatchToolCall('call_reused_arguments', '.approved.txt', 'approved');
        const substituted = filePatchToolCall('call_reused_arguments', '.substituted.txt', 'substituted');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, approved),
            permissionRequestedEvent(sessionId, approved),
            approvalRequestedEvent(sessionId, approved),
            providerToolCallEvent(sessionId, substituted),
            runBlockedEvent(sessionId, substituted.toolCallId),
        ]);

        try {
            const status = await settleDesktopApproval(
                approvalDecision(sessionId, `approval_permission_${approved.toolCallId}`, 'approve original effect'),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );

            expect(status).toBe('idle');
            await expect(readFile(join(workspaceRoot, '.substituted.txt'), 'utf8')).rejects.toThrow();
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('rejects identical approval provenance inherited from an earlier run', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-cross-run-approval-'));
        const sessionId = 'session_cross_run_approval';
        const toolCall = filePatchToolCall('call_reused_across_runs', '.cross-run.txt', 'must not write');
        const firstRunId = 'run_first_reused_tool_call';
        const secondRunId = 'run_second_reused_tool_call';
        const store = createMemoryApprovalStore([
            runStartedEvent(sessionId, firstRunId),
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
            runBlockedEvent(sessionId, toolCall.toolCallId, firstRunId),
            runCompletedEvent(sessionId, firstRunId),
            runStartedEvent(sessionId, secondRunId),
            providerToolCallEvent(sessionId, toolCall),
            runBlockedEvent(sessionId, toolCall.toolCallId, secondRunId),
        ]);
        let effectReservations = 0;
        const backfillStore = {
            ...store,
            reserveDesktopApprovalEffect: async (effect: Parameters<typeof store.reserveDesktopApprovalEffect>[0]) => {
                effectReservations += 1;
                return store.reserveDesktopApprovalEffect(effect);
            },
        };

        try {
            await ensurePendingToolApprovalForCurrentBlockedRun({
                store: backfillStore,
                sessionId,
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                now: () => '2026-06-09T00:00:00.000Z',
                blockedToolCallId: toolCall.toolCallId,
                workspaceRoot,
            });
            const status = await settleDesktopApproval(
                approvalDecision(sessionId, `approval_permission_${toolCall.toolCallId}`, 'stale cross-run approval'),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );

            expect(status).toBe('idle');
            expect(effectReservations).toBe(0);
            expect(countEvents(store.events, 'approval.updated')).toBe(0);
            await expect(readFile(join(workspaceRoot, '.cross-run.txt'), 'utf8')).rejects.toThrow();
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});
