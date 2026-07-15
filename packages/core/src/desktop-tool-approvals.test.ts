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
    runFailedEvent,
} from './desktop-tool-approval-test-support';
import { ensurePendingToolApprovalForCurrentBlockedRun, settleDesktopApproval } from './desktop-tool-approvals';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('desktop tool approval provenance', () => {
    it('mints approval.requested only when current blocked run already has matching permission provenance', async () => {
        const sessionId = 'session_current_permission_provenance';
        const toolCall = filePatchToolCall('call_current_permission_provenance', '.safe.txt', 'safe');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
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

    it('reopens a runtime-cancelled approval when its current run is resumably blocked', async () => {
        const sessionId = 'session_cancelled_blocked_approval';
        const toolCall = filePatchToolCall('call_cancelled_blocked', '.safe.txt', 'safe');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
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

        expect(countEvents(store.events, 'approval.requested')).toBe(2);
        expect(store.events.at(-1)?.approvalRecord?.state).toBe('pending');
    });

    it('does not reopen a forged cancelled approval without a prior runtime pending request', async () => {
        const sessionId = 'session_forged_cancelled_approval';
        const toolCall = filePatchToolCall('call_forged_cancelled', '.forged.txt', 'forged');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
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

        expect(countEvents(store.events, 'approval.requested')).toBe(0);
    });

    it('does not reopen a cancelled approval whose permission action mismatches the tool proposal', async () => {
        const sessionId = 'session_mismatched_permission_action';
        const toolCall = filePatchToolCall('call_mismatched_action', '.safe.txt', 'safe');
        const permission = permissionRequestedEvent(sessionId, toolCall);
        if (permission.permissionRequest === undefined) {
            throw new Error('permission test fixture must include a request');
        }
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            {
                ...permission,
                permissionRequest: { ...permission.permissionRequest, action: 'file.write' },
            },
            approvalRequestedEvent(sessionId, toolCall),
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

    it.each(['approved', 'denied'] as const)('does not reopen a terminal %s approval', async (state) => {
        const sessionId = `session_terminal_${state}_approval`;
        const toolCall = filePatchToolCall(`call_terminal_${state}`, '.safe.txt', 'safe');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
            approvalUpdatedEvent(sessionId, toolCall, state),
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

    it('does not reopen an operator-cancelled approval.updated record', async () => {
        const sessionId = 'session_operator_cancelled_approval';
        const toolCall = filePatchToolCall('call_operator_cancelled', '.safe.txt', 'safe');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
            approvalUpdatedEvent(sessionId, toolCall, 'cancelled'),
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

    it('serializes concurrent approval backfill so only one pending record is appended', async () => {
        const sessionId = 'session_concurrent_cancelled_approval';
        const toolCall = filePatchToolCall('call_concurrent_cancelled', '.safe.txt', 'safe');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
            approvalBlockedCancelledEvent(sessionId, toolCall),
            runBlockedEvent(sessionId, toolCall.toolCallId),
        ]);
        const input = {
            store,
            sessionId,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' } as const,
            now: () => '2026-06-09T00:00:00.000Z',
            blockedToolCallId: toolCall.toolCallId,
            workspaceRoot: '/workspace',
        };

        await Promise.all([
            ensurePendingToolApprovalForCurrentBlockedRun(input),
            ensurePendingToolApprovalForCurrentBlockedRun(input),
        ]);

        expect(countEvents(store.events, 'approval.requested')).toBe(2);
    });

    it('does not mint approval.requested from stale tool history without runtime approval provenance', async () => {
        const sessionId = 'session_no_runtime_provenance';
        const toolCall = filePatchToolCall('call_no_runtime_provenance', '.stale.txt', 'must not write');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
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

        expect(countEvents(store.events, 'approval.requested')).toBe(0);
    });

    it('ignores approval provenance that does not match the current blocked tool call', async () => {
        const sessionId = 'session_stale_mismatch';
        const staleToolCall = filePatchToolCall('call_stale', '.stale.txt', 'stale');
        const currentToolCall = filePatchToolCall('call_current', '.current.txt', 'current');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, staleToolCall),
            permissionRequestedEvent(sessionId, staleToolCall),
            approvalRequestedEvent(sessionId, staleToolCall),
            providerToolCallEvent(sessionId, currentToolCall),
            runBlockedEvent(sessionId, currentToolCall.toolCallId),
        ]);

        await ensurePendingToolApprovalForCurrentBlockedRun({
            store,
            sessionId,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            now: () => '2026-06-09T00:00:00.000Z',
            blockedToolCallId: currentToolCall.toolCallId,
            workspaceRoot: '/workspace',
        });

        expect(countEvents(store.events, 'approval.requested')).toBe(1);
    });

    it('returns idle for forged pending approval history that lacks runtime permission provenance', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-approval-provenance-'));
        const sessionId = 'session_forged_pending_approval';
        const toolCall = filePatchToolCall('call_forged_pending', '.forged.txt', 'must not write');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
            runBlockedEvent(sessionId, toolCall.toolCallId),
        ]);

        try {
            const status = await settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_call_forged_pending', 'forged approve'),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );

            expect(status).toBe('idle');
            expect(countEvents(store.events, 'approval.updated')).toBe(0);
            expect(countEvents(store.events, 'file.diff.applied')).toBe(0);
            await expect(readFile(join(workspaceRoot, '.forged.txt'), 'utf8')).rejects.toThrow();
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('does not execute duplicate approval twice after the first decision settles', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-duplicate-approval-'));
        const sessionId = 'session_duplicate_approval';
        const toolCall = filePatchToolCall('call_duplicate', '.duplicate.txt', 'approved once');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
            runBlockedEvent(sessionId, toolCall.toolCallId),
        ]);

        try {
            const first = await settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_call_duplicate', 'first approve'),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );

            expect(first).toBe('completed');

            const second = await settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_call_duplicate', 'duplicate approve'),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );

            expect(second).toBe('idle');
            expect(countEvents(store.events, 'file.diff.applied')).toBe(1);
            expect(countEvents(store.events, 'approval.resumed')).toBe(1);
            expect(await readFile(join(workspaceRoot, '.duplicate.txt'), 'utf8')).toBe('approved once\n');
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('returns idle for approval decision after run failure', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-approval-after-failure-'));
        const sessionId = 'session_approval_after_failure';
        const toolCall = filePatchToolCall('call_after_failure', '.after-failure.txt', 'must not write');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
            runBlockedEvent(sessionId, toolCall.toolCallId),
            runFailedEvent(sessionId),
        ]);

        try {
            const status = await settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_call_after_failure', 'late approve after failure'),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );

            expect(status).toBe('idle');
            expect(countEvents(store.events, 'approval.updated')).toBe(0);
            expect(countEvents(store.events, 'file.diff.applied')).toBe(0);
            await expect(readFile(join(workspaceRoot, '.after-failure.txt'), 'utf8')).rejects.toThrow();
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('returns idle for approval decision when no blocked run exists', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-no-blocked-run-'));
        const sessionId = 'session_no_blocked_run';
        const toolCall = filePatchToolCall('call_no_blocked', '.no-blocked.txt', 'must not write');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
        ]);

        try {
            const status = await settleDesktopApproval(
                approvalDecision(sessionId, 'approval_permission_call_no_blocked', 'approve without blocked run'),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );

            expect(status).toBe('idle');
            expect(countEvents(store.events, 'approval.updated')).toBe(0);
            expect(countEvents(store.events, 'file.diff.applied')).toBe(0);
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});
