import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import type { DesktopApprovalEffect } from './desktop-approval-effect';
import {
    approvalDecision,
    approvalOptions,
    approvalRequestedEvent,
    commandToolCall,
    completedCommandResult,
    permissionRequestedEvent,
    providerToolCallEvent,
    runBlockedEvent,
} from './desktop-tool-approval-test-support';
import type { DesktopApprovalStore } from './desktop-tool-approvals';
import { settleDesktopApproval } from './desktop-tool-approvals';
import { openLocalSessionEventStore } from './memory/local-session-store';
import { tempDataDir } from './memory/local-session-store-test-support';

const CLAIMED_AT = '2026-07-15T01:00:00.000Z';
const LEASE_EXPIRES_AT = '2026-07-15T01:01:00.000Z';
const RECOVERY_AT = '2026-07-15T01:02:00.000Z';

describe('desktop approval crash recovery', () => {
    it('does not execute after a crash between claim and physical effect', async () => {
        // Given: the first process durably claims, then disappears before invoking the tool.
        const dataDir = await tempDataDir('approval-crash-before-effect');
        const sessionId = 'session_crash_before_effect';
        const toolCall = commandToolCall('call_crash_before_effect');
        const effect = approvalEffect(sessionId, toolCall.toolCallId, dataDir);
        const firstProcess = await seededStore(dataDir, sessionId, toolCall);
        await firstProcess.reserveDesktopApprovalEffect(effect);
        await firstProcess.claimDesktopApprovalEffect({
            effect,
            executionToken: 'execution_token_before_effect',
            leaseExpiresAt: LEASE_EXPIRES_AT,
        });
        await firstProcess.close();
        const recoveredProcess = await openLocalSessionEventStore({ dataDir, sessionId, now: () => RECOVERY_AT });
        let executions = 0;

        // When: approval settlement is retried after recovery.
        const status = await settleDesktopApproval(
            approvalDecision(sessionId, effect.approvalId, 'retry after crash before effect'),
            approvalOptions({
                store: recoveredProcess,
                sessionId,
                workspaceRoot: effect.workspaceRoot,
                now: () => RECOVERY_AT,
                commandExecutor: async () => {
                    executions += 1;
                    return completedCommandResult();
                },
            }),
        );
        await recoveredProcess.close();

        // Then: uncertainty is surfaced and physical execution is never replayed.
        expect(status).toBe('unknown');
        expect(executions).toBe(0);
    });

    it('does not replay after a crash between physical effect and durable result events', async () => {
        // Given: a real libSQL store whose result-event append crashes after the command ran.
        const dataDir = await tempDataDir('approval-crash-after-effect');
        const sessionId = 'session_crash_after_effect';
        const toolCall = commandToolCall('call_crash_after_effect');
        const effect = approvalEffect(sessionId, toolCall.toolCallId, dataDir);
        const firstProcess = await seededStore(dataDir, sessionId, toolCall);
        let executions = 0;
        const crashingStore: DesktopApprovalStore = {
            append: async (event: AgentEvent) => {
                if (executions === 1) throw new Error('simulated process crash before durable result append');
                await firstProcess.append(event);
            },
            getEvents: (requestedSessionId) => firstProcess.getEvents(requestedSessionId),
            getDesktopApprovalToolCall: (toolCallId) => firstProcess.getDesktopApprovalToolCall(toolCallId),
            reserveDesktopApprovalEffect: (candidate) => firstProcess.reserveDesktopApprovalEffect(candidate),
            claimDesktopApprovalEffect: (claim) => firstProcess.claimDesktopApprovalEffect(claim),
            settleDesktopApprovalEffect: (settlement) => firstProcess.settleDesktopApprovalEffect(settlement),
            getDesktopApprovalEffect: (approvalId) => firstProcess.getDesktopApprovalEffect(approvalId),
            resolveDesktopApprovalEffect: (resolution) => firstProcess.resolveDesktopApprovalEffect(resolution),
        };
        await expect(
            settleDesktopApproval(
                approvalDecision(sessionId, effect.approvalId, 'approve before simulated crash'),
                approvalOptions({
                    store: crashingStore,
                    sessionId,
                    workspaceRoot: effect.workspaceRoot,
                    now: () => CLAIMED_AT,
                    executionLeaseMs: 60_000,
                    commandExecutor: async () => {
                        executions += 1;
                        return completedCommandResult();
                    },
                }),
            ),
        ).rejects.toThrow('simulated process crash');
        await firstProcess.close();

        // When: a later process recovers and the operator retries the same approval.
        const recoveredProcess = await openLocalSessionEventStore({ dataDir, sessionId, now: () => RECOVERY_AT });
        const status = await settleDesktopApproval(
            approvalDecision(sessionId, effect.approvalId, 'retry after crash after effect'),
            approvalOptions({
                store: recoveredProcess,
                sessionId,
                workspaceRoot: effect.workspaceRoot,
                now: () => RECOVERY_AT,
                commandExecutor: async () => {
                    executions += 1;
                    return completedCommandResult();
                },
            }),
        );
        const record = await recoveredProcess.getDesktopApprovalEffect(effect.approvalId);
        await recoveredProcess.close();

        // Then: the physical effect happened once and remains explicitly unknown.
        expect(status).toBe('unknown');
        expect(executions).toBe(1);
        expect(record).toMatchObject({ state: 'unknown' });
    });

    it.each([
        { exitCode: 0, expectedStatus: 'completed', expectedOutcome: 'completed' },
        { exitCode: 1, expectedStatus: 'failed', expectedOutcome: 'failed' },
    ] as const)('durably settles normal $expectedOutcome execution only after its result events', async ({
        exitCode,
        expectedStatus,
        expectedOutcome,
    }) => {
        // Given: a pending approval backed by a real libSQL effect ledger.
        const dataDir = await tempDataDir(`approval-normal-${expectedOutcome}`);
        const sessionId = `session_normal_${expectedOutcome}`;
        const toolCall = commandToolCall(`call_normal_${expectedOutcome}`);
        const store = await seededStore(dataDir, sessionId, toolCall);

        // When: the physical command returns a known success or failure.
        const status = await settleDesktopApproval(
            approvalDecision(sessionId, `approval_permission_${toolCall.toolCallId}`, `approve ${expectedOutcome}`),
            approvalOptions({
                store,
                sessionId,
                workspaceRoot: dataDir,
                now: () => CLAIMED_AT,
                commandExecutor: async () => ({ ...completedCommandResult(), exitCode }),
            }),
        );
        const effectRecord = await store.getDesktopApprovalEffect(`approval_permission_${toolCall.toolCallId}`);
        const events = await store.getEvents(sessionId);
        await store.close();

        // Then: durable result events exist and the token-fenced row carries the matching outcome.
        expect(status).toBe(expectedStatus);
        expect(events.some((event) => event.type === (exitCode === 0 ? 'tool.completed' : 'tool.failed'))).toBe(true);
        expect(effectRecord).toMatchObject({ state: 'settled', outcome: expectedOutcome });
    });
});

async function seededStore(dataDir: string, sessionId: string, toolCall: ReturnType<typeof commandToolCall>) {
    const store = await openLocalSessionEventStore({ dataDir, sessionId, now: () => CLAIMED_AT });
    for (const event of [
        providerToolCallEvent(sessionId, toolCall),
        permissionRequestedEvent(sessionId, toolCall),
        approvalRequestedEvent(sessionId, toolCall),
        runBlockedEvent(sessionId, toolCall.toolCallId),
    ]) {
        await store.append(event);
    }
    return store;
}

function approvalEffect(sessionId: string, toolCallId: string, workspaceRoot: string): DesktopApprovalEffect {
    return {
        sessionId,
        approvalId: `approval_permission_${toolCallId}`,
        runId: `run_${toolCallId}`,
        toolCallId,
        toolName: 'command.run',
        argumentsJson: commandToolCall(toolCallId).argumentsJson,
        workspaceRoot,
    };
}
