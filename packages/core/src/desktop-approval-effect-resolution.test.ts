import { describe, expect, it } from 'vitest';
import type { DesktopApprovalEffect } from './desktop-approval-effect';
import { createDesktopSessionCommandService } from './desktop-session-commands';
import { openLocalSessionEventStore } from './memory/local-session-store';
import { tempDataDir } from './memory/local-session-store-test-support';
import { createDeterministicProvider } from './providers/deterministic-provider';

const STARTED_AT = '2026-07-15T03:00:00.000Z';
const EXPIRED_AT = '2026-07-15T03:01:00.000Z';
const RECOVERED_AT = '2026-07-15T03:02:00.000Z';

describe('desktop approval effect operator resolution command', () => {
    it('marks an unknown effect completed without invoking its physical executor', async () => {
        // Given: restart recovery has an ambiguous effect requiring operator resolution.
        const dataDir = await tempDataDir('approval-effect-command-resolution');
        const effect = approvalEffect();
        const firstProcess = await openLocalSessionEventStore({
            dataDir,
            sessionId: effect.sessionId,
            now: () => STARTED_AT,
        });
        await firstProcess.reserveDesktopApprovalEffect(effect);
        await firstProcess.claimDesktopApprovalEffect({
            effect,
            executionToken: 'execution_token_command_resolution',
            leaseExpiresAt: EXPIRED_AT,
        });
        await firstProcess.close();
        const recoveryProcess = await openLocalSessionEventStore({
            dataDir,
            sessionId: effect.sessionId,
            now: () => RECOVERED_AT,
        });
        await recoveryProcess.close();
        let physicalExecutions = 0;
        const service = createDesktopSessionCommandService({
            dataDir,
            workspaceRoot: effect.workspaceRoot,
            now: () => RECOVERED_AT,
            provider: createDeterministicProvider([{ kind: 'response_completed', content: 'unused' }]),
            commandExecutor: async () => {
                physicalExecutions += 1;
                return { exitCode: 0, signal: null, stdout: '', stderr: '', timedOut: false, durationMs: 0 };
            },
        });

        // When: the core command seam explicitly resolves the unknown outcome.
        const receipt = await service.resolveApprovalEffect({
            sessionId: effect.sessionId,
            approvalId: effect.approvalId,
            outcome: 'completed',
        });
        const record = await service.getApprovalEffect({
            sessionId: effect.sessionId,
            approvalId: effect.approvalId,
        });

        // Then: the operator outcome is public and durable without replaying the tool.
        expect(receipt).toMatchObject({ status: 'resolved', effect: { state: 'unknown', outcome: 'completed' } });
        expect(record).toMatchObject({ state: 'unknown', outcome: 'completed', resolvedAt: RECOVERED_AT });
        expect(physicalExecutions).toBe(0);
    });
});

function approvalEffect(): DesktopApprovalEffect {
    return {
        sessionId: 'session_effect_command_resolution',
        approvalId: 'approval_effect_command_resolution',
        runId: 'run_effect_command_resolution',
        toolCallId: 'call_effect_command_resolution',
        toolName: 'command.run',
        argumentsJson: '{"command":"node","args":["--version"]}',
        workspaceRoot: '/workspace',
    };
}
