import { describe, expect, it } from 'vitest';
import {
    approvalBlockedCancelledEvent,
    approvalDecision,
    approvalOptions,
    approvalRequestedEvent,
    commandToolCall,
    completedCommandResult,
    countEvents,
    createMemoryApprovalStore,
    filePatchToolCall,
    fileWriteToolCall,
    permissionRequestedEvent,
    providerToolCallEvent,
    runBlockedEvent,
    runCompletedEvent,
} from './desktop-tool-approval-test-support';
import { ensurePendingToolApprovalForCurrentBlockedRun, settleDesktopApproval } from './desktop-tool-approvals';
import { openLocalSessionEventStore } from './memory/local-session-store-open';
import { createObservabilityRedactor } from './providers/observability-redactor';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('desktop tool approval durable security', () => {
    it('rejects settlement from a workspace different from the approval effect target', async () => {
        const approvedWorkspace = await mkdtemp(join(tmpdir(), 'mctrl-desktop-approved-workspace-'));
        const substitutedWorkspace = await mkdtemp(join(tmpdir(), 'mctrl-desktop-substituted-workspace-'));
        const sessionId = 'session_workspace_substitution';
        const toolCall = filePatchToolCall('call_workspace_substitution', '.workspace-bound.txt', 'bound');
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            runBlockedEvent(sessionId, toolCall.toolCallId),
        ]);
        const pendingInput = {
            store,
            sessionId,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' } as const,
            now: () => '2026-06-09T00:00:00.000Z',
            blockedToolCallId: toolCall.toolCallId,
            workspaceRoot: approvedWorkspace,
        };

        try {
            await ensurePendingToolApprovalForCurrentBlockedRun(pendingInput);
            const status = await settleDesktopApproval(
                approvalDecision(sessionId, `approval_permission_${toolCall.toolCallId}`, 'substitute workspace'),
                approvalOptions({ store, sessionId, workspaceRoot: substitutedWorkspace }),
            );

            expect(status).toBe('idle');
            await expect(readFile(join(substitutedWorkspace, '.workspace-bound.txt'), 'utf8')).rejects.toThrow();
        } finally {
            await Promise.all([
                rm(approvedWorkspace, { recursive: true, force: true }),
                rm(substitutedWorkspace, { recursive: true, force: true }),
            ]);
        }
    });

    it('executes the private approved arguments while persisted events remain redacted', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-private-proposal-data-'));
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-private-proposal-workspace-'));
        const sessionId = 'session_private_approval_proposal';
        const secretContent = 'private_approval_secret_value';
        const toolCall = fileWriteToolCall('call_private_approval_proposal', 'private.txt', secretContent, false);
        const store = await openLocalSessionEventStore({
            dataDir,
            sessionId,
            now: () => '2026-06-09T00:00:00.000Z',
            observabilityRedactor: createObservabilityRedactor({ secrets: [secretContent] }),
        });

        try {
            for (const event of [
                providerToolCallEvent(sessionId, toolCall),
                permissionRequestedEvent(sessionId, toolCall),
                approvalRequestedEvent(sessionId, toolCall),
                runBlockedEvent(sessionId, toolCall.toolCallId),
            ]) {
                await store.append(event);
            }
            await ensurePendingToolApprovalForCurrentBlockedRun({
                store,
                sessionId,
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                now: () => '2026-06-09T00:00:00.000Z',
                blockedToolCallId: toolCall.toolCallId,
                workspaceRoot,
            });

            const status = await settleDesktopApproval(
                approvalDecision(sessionId, `approval_permission_${toolCall.toolCallId}`, 'approve private content'),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );
            const events = await store.getEvents(sessionId);

            expect(status).toBe('completed');
            await expect(readFile(join(workspaceRoot, 'private.txt'), 'utf8')).resolves.toBe(secretContent);
            expect(JSON.stringify(events)).not.toContain(secretContent);
            expect(JSON.stringify(events)).toContain('[REDACTED_CREDENTIAL]');
        } finally {
            await store.close();
            await Promise.all([
                rm(dataDir, { recursive: true, force: true }),
                rm(workspaceRoot, { recursive: true, force: true }),
            ]);
        }
    });

    it('does not reactivate a completed run from a delayed stale blocked event', async () => {
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-stale-blocked-'));
        const sessionId = 'session_terminal_then_stale_blocked';
        const toolCall = filePatchToolCall('call_terminal_then_stale_blocked', '.stale-blocked.txt', 'stale');
        const runId = `run_${toolCall.toolCallId}`;
        const store = createMemoryApprovalStore([
            providerToolCallEvent(sessionId, toolCall),
            permissionRequestedEvent(sessionId, toolCall),
            approvalRequestedEvent(sessionId, toolCall),
            approvalBlockedCancelledEvent(sessionId, toolCall),
            runCompletedEvent(sessionId, runId),
            runBlockedEvent(sessionId, toolCall.toolCallId),
        ]);

        try {
            await ensurePendingToolApprovalForCurrentBlockedRun({
                store,
                sessionId,
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                now: () => '2026-06-09T00:00:00.000Z',
                blockedToolCallId: toolCall.toolCallId,
                workspaceRoot,
            });
            const status = await settleDesktopApproval(
                approvalDecision(sessionId, `approval_permission_${toolCall.toolCallId}`, 'stale approve'),
                approvalOptions({ store, sessionId, workspaceRoot }),
            );

            expect(status).toBe('idle');
            expect(countEvents(store.events, 'approval.requested')).toBe(1);
            await expect(readFile(join(workspaceRoot, '.stale-blocked.txt'), 'utf8')).rejects.toThrow();
        } finally {
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('allows one durable settlement across distinct store objects', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-distinct-store-data-'));
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-distinct-store-race-'));
        const sessionId = 'session_distinct_store_race';
        const toolCall = commandToolCall('call_distinct_store_race');
        const firstStore = await openLocalSessionEventStore({
            dataDir,
            sessionId,
            now: () => '2026-06-09T00:00:00.000Z',
        });
        const secondStore = await openLocalSessionEventStore({
            dataDir,
            sessionId,
            now: () => '2026-06-09T00:00:00.000Z',
        });
        let commandExecutions = 0;
        const execute = async () => {
            commandExecutions += 1;
            return completedCommandResult();
        };

        try {
            for (const event of [
                providerToolCallEvent(sessionId, toolCall),
                permissionRequestedEvent(sessionId, toolCall),
                approvalRequestedEvent(sessionId, toolCall),
                runBlockedEvent(sessionId, toolCall.toolCallId),
            ]) {
                await firstStore.append(event);
            }
            await ensurePendingToolApprovalForCurrentBlockedRun({
                store: firstStore,
                sessionId,
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                now: () => '2026-06-09T00:00:00.000Z',
                blockedToolCallId: toolCall.toolCallId,
                workspaceRoot,
            });
            const statuses = await Promise.all(
                [firstStore, secondStore].map((store) =>
                    settleDesktopApproval(
                        approvalDecision(sessionId, `approval_permission_${toolCall.toolCallId}`, 'one decision'),
                        approvalOptions({ store, sessionId, workspaceRoot, commandExecutor: execute }),
                    ),
                ),
            );

            expect(statuses).toEqual(expect.arrayContaining(['completed', 'idle']));
            expect(commandExecutions).toBe(1);
        } finally {
            await Promise.all([firstStore.close(), secondStore.close()]);
            await Promise.all([
                rm(dataDir, { recursive: true, force: true }),
                rm(workspaceRoot, { recursive: true, force: true }),
            ]);
        }
    });
});
