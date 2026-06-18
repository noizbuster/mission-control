import { defaultModelProviderSelection } from '@mission-control/config';
import type { ProviderStreamChunk } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createDesktopSessionCommandService } from './desktop-session-commands.js';
import { commandRunCall, filePatchCall, fixedNow, readReplay } from './desktop-session-commands-test-support.js';
import {
    assertAttachesToExistingRunOwner,
    assertDoesNotStartSecondActiveRun,
    assertInterruptPreservesApprovalDiagnostics,
    assertResumesBlockedWorkAfterReopeningStore,
} from './desktop-session-run-owner-scenarios.test-support.js';
import { JsonlSessionEventStore } from './memory/jsonl-session-event-store.js';
import { createDeterministicProvider } from './providers/deterministic-provider.js';
import type { ProviderAdapter, ProviderTurnRequest } from './providers/provider-turn-types.js';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('desktop session command service', () => {
    it('writes a submitted desktop prompt to the durable JSONL session log', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-prompt-'));
        const service = createDesktopSessionCommandService({
            dataDir,
            workspaceRoot: dataDir,
            now: fixedNow,
            provider: createDeterministicProvider([{ kind: 'response_completed', content: 'desktop answer' }]),
        });

        try {
            // When
            const receipt = await service.submitPrompt({
                sessionId: 'session_desktop_prompt',
                prompt: 'summarize the repo from desktop',
                modelProviderSelection: defaultModelProviderSelection,
            });

            // Then
            const replay = await readReplay(dataDir, 'session_desktop_prompt');
            expect(receipt.status).toBe('completed');
            expect(replay.events.map((event) => event.type)).toEqual(
                expect.arrayContaining(['prompt.admitted', 'prompt.promoted', 'run.completed']),
            );
            expect(replay.events.find((event) => event.type === 'prompt.admitted')?.message).toBe(
                'summarize the repo from desktop',
            );
            // Graph emits model.call.completed with final text in `message` (flat carried it on
            // providerStreamChunk). Asserting the message keeps the test engine-agnostic.
            expect(replay.events.find((event) => event.type === 'model.call.completed')?.message).toBe(
                'desktop answer',
            );
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });

    it('persists approval denial and leaves requested file and command effects untouched', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-deny-'));
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-deny-workspace-'));
        const service = createDesktopSessionCommandService({
            dataDir,
            workspaceRoot,
            now: fixedNow,
            provider: createDeterministicProvider([
                { kind: 'text_delta', delta: 'I can patch.' },
                filePatchCall('call_patch_denied', '.mission-control-denied.txt', 'denied write'),
                commandRunCall('call_test_denied'),
                { kind: 'response_completed', content: 'approval required' },
            ]),
        });

        try {
            // When
            await service.submitPrompt({
                sessionId: 'session_desktop_denied',
                prompt: 'deterministic patch and test',
                modelProviderSelection: defaultModelProviderSelection,
            });
            const receipt = await service.decideApproval({
                sessionId: 'session_desktop_denied',
                approvalId: 'approval_permission_call_patch_denied',
                state: 'denied',
                reason: 'manual desktop denial',
            });

            // Then
            const replay = await readReplay(dataDir, 'session_desktop_denied');
            await expect(stat(join(workspaceRoot, '.mission-control-denied.txt'))).rejects.toMatchObject({
                code: 'ENOENT',
            });
            expect(receipt.status).toBe('blocked');
            expect(replay.events.map((event) => event.type)).toEqual(
                expect.arrayContaining([
                    'permission.requested',
                    'approval.requested',
                    'approval.updated',
                    'approval.blocked',
                ]),
            );
            expect(replay.events.map((event) => event.type)).not.toContain('file.diff.applied');
            expect(replay.events.map((event) => event.type)).not.toContain('command.completed');
        } finally {
            await rm(dataDir, { recursive: true, force: true });
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('replays stepwise desktop approvals after restart without minting ahead', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-allow-'));
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-allow-workspace-'));
        // The graph path re-runs the conversation from messages on each resume (the flat path
        // blocked on the first tool call without execution). Use a stateful provider so each turn
        // surfaces the next pending tool: patch first, then command, then a final text answer.
        // stepwiseProvider[0] = patch turn, [1] = command turn, [2] = continuation text turn.
        const provider = stepwiseProvider();
        const commandExecutor = async () => ({
            exitCode: 0,
            signal: null,
            stdout: 'desktop test passed\n',
            stderr: '',
            timedOut: false,
            durationMs: 7,
        });
        const firstProcess = createDesktopSessionCommandService({
            dataDir,
            workspaceRoot,
            now: fixedNow,
            provider,
            commandExecutor,
        });

        try {
            await firstProcess.submitPrompt({
                sessionId: 'session_desktop_allowed',
                prompt: 'deterministic patch and test',
                modelProviderSelection: defaultModelProviderSelection,
            });
            const restartedProcess = createDesktopSessionCommandService({
                dataDir,
                workspaceRoot,
                now: fixedNow,
                provider,
                commandExecutor,
            });

            // When
            const patchReceipt = await restartedProcess.decideApproval({
                sessionId: 'session_desktop_allowed',
                approvalId: 'approval_permission_call_patch_allowed',
                state: 'approved',
                reason: 'desktop approved patch',
            });
            const commandReceipt = await restartedProcess.decideApproval({
                sessionId: 'session_desktop_allowed',
                approvalId: 'approval_permission_call_test_allowed',
                state: 'approved',
                reason: 'desktop approved test',
            });

            // Then
            const written = await readFile(join(workspaceRoot, '.mission-control-allowed.txt'), 'utf8');
            const replay = await readReplay(dataDir, 'session_desktop_allowed');
            expect(written).toBe('approved write\n');
            expect(patchReceipt.status).toBe('blocked_on_approval');
            expect(commandReceipt.status).toBe('completed');
            expect(replay.approvals).toEqual(
                expect.arrayContaining([
                    expect.objectContaining({
                        approvalId: 'approval_permission_call_patch_allowed',
                        state: 'approved',
                    }),
                    expect.objectContaining({
                        approvalId: 'approval_permission_call_test_allowed',
                        state: 'approved',
                    }),
                ]),
            );
            expect(replay.events.map((event) => event.type)).toEqual(
                expect.arrayContaining(['approval.resumed', 'file.diff.applied', 'tool.completed', 'run.completed']),
            );
        } finally {
            await rm(dataDir, { recursive: true, force: true });
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('attaches to existing run owner', async () => {
        await assertAttachesToExistingRunOwner();
    });

    it('does not start a second active run', async () => {
        await assertDoesNotStartSecondActiveRun();
    });

    it('resumes blocked work after reopening the store', async () => {
        await assertResumesBlockedWorkAfterReopeningStore();
    });

    it('keeps approval diagnostics when an approval wait is interrupted', async () => {
        await assertInterruptPreservesApprovalDiagnostics();
    });

    it('does not mint approval.requested from historical tool calls during resume', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-no-backfill-'));
        const sessionId = 'session_desktop_no_backfill';
        const store = await JsonlSessionEventStore.open({ dataDir, sessionId, now: fixedNow });
        const service = createDesktopSessionCommandService({
            dataDir,
            workspaceRoot: dataDir,
            now: fixedNow,
            provider: createDeterministicProvider([{ kind: 'response_completed', content: 'resume noop' }]),
        });

        try {
            await store.append({
                type: 'session.started',
                timestamp: fixedNow(),
                sessionId,
                message: 'desktop session started',
                nativeSidecarStatus: 'mock',
                modelProviderSelection: defaultModelProviderSelection,
            });
            await store.append({
                type: 'model.call.completed',
                timestamp: fixedNow(),
                sessionId,
                message: 'tool call completed: file.patch',
                nativeSidecarStatus: 'mock',
                modelProviderSelection: defaultModelProviderSelection,
                providerStreamChunk: {
                    kind: 'tool_call_completed',
                    requestId: 'request_no_backfill',
                    sequence: 1,
                    toolCall: {
                        toolCallId: 'call_no_backfill',
                        toolName: 'file.patch',
                        argumentsJson: '{"patch":"diff --git a/a b/a"}',
                    },
                },
            });
            await store.append({
                type: 'run.blocked',
                timestamp: fixedNow(),
                sessionId,
                message: 'waiting for approval: file.patch',
                nativeSidecarStatus: 'mock',
                modelProviderSelection: defaultModelProviderSelection,
                run: {
                    command: 'run',
                    state: 'blocked_on_approval',
                    runId: 'run_no_backfill',
                    reason: 'waiting for approval: file.patch',
                    toolCallId: 'call_no_backfill',
                },
            });
        } finally {
            await store.close();
        }

        try {
            await service.resumeRun({ sessionId });

            const replay = await readReplay(dataDir, sessionId);
            expect(replay.events.map((event) => event.type)).not.toContain('approval.requested');
        } finally {
            await rm(dataDir, { recursive: true, force: true });
        }
    });
});

/**
 * Stateful provider for stepwise-approval: each turn surfaces the NEXT pending tool
 * (patch → command → final text), matching the graph's re-run-from-messages resume semantics.
 */
function stepwiseProvider(): ProviderAdapter {
    let turn = 0;
    return {
        async *streamTurn(request: ProviderTurnRequest): AsyncGenerator<ProviderStreamChunk> {
            turn += 1;
            if (turn === 1) {
                const patch = filePatchCall('call_patch_allowed', '.mission-control-allowed.txt', 'approved write\n');
                if (patch.kind !== 'tool_call_completed') {
                    throw new TypeError('expected file.patch tool call step');
                }
                yield {
                    kind: 'tool_call_completed',
                    requestId: request.requestId,
                    sequence: 1,
                    toolCall: { toolCallId: patch.toolCallId, toolName: patch.toolName, argumentsJson: patch.argumentsJson },
                };
                yield {
                    kind: 'response_completed',
                    requestId: request.requestId,
                    sequence: 2,
                    message: {
                        messageId: 'assistant_stepwise_patch',
                        role: 'assistant',
                        content: 'approval required',
                        providerToolCalls: [
                            { providerID: 'local', toolCallId: patch.toolCallId, toolName: patch.toolName, argumentsJson: patch.argumentsJson },
                        ],
                    },
                    finishReason: 'tool_calls',
                };
                return;
            }
            if (turn === 2) {
                const command = commandRunCall('call_test_allowed');
                if (command.kind !== 'tool_call_completed') {
                    throw new TypeError('expected command.run tool call step');
                }
                yield {
                    kind: 'tool_call_completed',
                    requestId: request.requestId,
                    sequence: 1,
                    toolCall: { toolCallId: command.toolCallId, toolName: command.toolName, argumentsJson: command.argumentsJson },
                };
                yield {
                    kind: 'response_completed',
                    requestId: request.requestId,
                    sequence: 2,
                    message: {
                        messageId: 'assistant_stepwise_command',
                        role: 'assistant',
                        content: 'approval required',
                        providerToolCalls: [
                            { providerID: 'local', toolCallId: command.toolCallId, toolName: command.toolName, argumentsJson: command.argumentsJson },
                        ],
                    },
                    finishReason: 'tool_calls',
                };
                return;
            }
            yield {
                kind: 'response_completed',
                requestId: request.requestId,
                sequence: 1,
                message: {
                    messageId: 'assistant_stepwise_done',
                    role: 'assistant',
                    content: 'mission complete',
                },
                finishReason: 'stop',
            };
        },
    };
}
