import { describe, expect, it } from 'vitest';
import {
    approvalDecision,
    approvalOptions,
    approvalRequestedEvent,
    countEvents,
    createMemoryApprovalStore,
    filePatchToolCall,
    permissionRequestedEvent,
    providerToolCallEvent,
    runBlockedEvent,
} from './desktop-tool-approval-test-support.js';
import { ensurePendingToolApprovalForCurrentBlockedRun, settleDesktopApproval } from './desktop-tool-approvals.js';
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
        });

        expect(countEvents(store.events, 'approval.requested')).toBe(1);
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
});
