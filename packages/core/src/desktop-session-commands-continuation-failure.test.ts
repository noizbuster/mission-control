import { defaultModelProviderSelection } from '@mission-control/config';
import type { AgentEvent } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createDesktopSessionCommandService } from './desktop-session-commands';
import { filePatchCall, fixedNow, readReplay } from './desktop-session-commands-test-support';
import type { ProviderAdapter } from './providers/provider-turn-types';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('desktop session command approval continuation failure', () => {
    it('preserves provider continuation failures after approval settlement', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-continue-failed-'));
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-continue-failed-workspace-'));
        const provider = failedContinuationProvider();
        const firstProcess = createDesktopSessionCommandService({
            dataDir,
            workspaceRoot,
            now: fixedNow,
            provider,
            modelProviderSelection: defaultModelProviderSelection,
        });

        try {
            await firstProcess.submitPrompt({
                sessionId: 'session_desktop_continue_failed',
                prompt: 'patch then continue',
                modelProviderSelection: defaultModelProviderSelection,
            });
            const restartedProcess = createDesktopSessionCommandService({
                dataDir,
                workspaceRoot,
                now: fixedNow,
                provider,
                modelProviderSelection: defaultModelProviderSelection,
            });

            const receipt = await restartedProcess.decideApproval({
                sessionId: 'session_desktop_continue_failed',
                approvalId: 'approval_permission_call_patch_continue',
                state: 'approved',
                reason: 'desktop approved continuation',
            });

            const replay = await readReplay(dataDir, 'session_desktop_continue_failed');
            expect(receipt.status).toBe('failed');
            expect(replay.events.at(-1)).toMatchObject({ type: 'run.failed' });
            expect(
                replay.events.some((event) => isGraphLlmErrorWithMessage(event, 'provider continuation failed')),
            ).toBe(true);
        } finally {
            await rm(dataDir, { recursive: true, force: true });
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});

function failedContinuationProvider(): ProviderAdapter {
    const requests: number[] = [];
    return {
        async *streamTurn(request) {
            requests.push(requests.length + 1);
            if (requests.length === 1) {
                const toolCall = filePatchCall('call_patch_continue', '.mission-control-continue.txt', 'continued');
                if (toolCall.kind !== 'tool_call_completed') {
                    throw new TypeError('expected file patch tool call');
                }
                yield {
                    kind: 'tool_call_completed',
                    requestId: request.requestId,
                    sequence: 1,
                    toolCall: {
                        toolCallId: toolCall.toolCallId,
                        toolName: toolCall.toolName,
                        argumentsJson: toolCall.argumentsJson,
                    },
                };
                yield {
                    kind: 'response_completed',
                    requestId: request.requestId,
                    sequence: 2,
                    message: {
                        messageId: 'assistant_needs_patch_failed',
                        role: 'assistant',
                        content: 'approval required',
                        providerToolCalls: [
                            {
                                providerID: 'local',
                                toolCallId: toolCall.toolCallId,
                                toolName: toolCall.toolName,
                                argumentsJson: toolCall.argumentsJson,
                            },
                        ],
                    },
                    finishReason: 'tool_calls',
                };
                return;
            }
            yield {
                kind: 'response_failed',
                requestId: request.requestId,
                sequence: 1,
                error: {
                    code: 'unknown',
                    message: 'provider continuation failed',
                    retryable: false,
                },
            };
        },
    };
}

function isGraphLlmErrorWithMessage(event: AgentEvent, message: string): boolean {
    if (event.type !== 'log') return false;
    const emit = event.abg?.emit;
    if (emit?.type !== 'llm.error') return false;
    const payload = emit.payload;
    if (typeof payload !== 'object' || payload === null || !('error' in payload)) return false;
    const error = payload.error;
    return typeof error === 'string' ? error === message : false;
}
