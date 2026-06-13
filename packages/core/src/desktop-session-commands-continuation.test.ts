import { defaultModelProviderSelection } from '@mission-control/config';
import { describe, expect, it } from 'vitest';
import { createDesktopSessionCommandService } from './desktop-session-commands.js';
import { filePatchCall, fixedNow, readReplay } from './desktop-session-commands-test-support.js';
import { JsonlSessionEventStore } from './memory/jsonl-session-event-store.js';
import type { ProviderAdapter, ProviderTurnRequest } from './providers/provider-turn-types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('desktop session command approval continuation', () => {
    it('continues the provider after the final approved desktop tool settlement', async () => {
        // Given
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-continue-'));
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-continue-workspace-'));
        const requests: ProviderTurnRequest[] = [];
        const provider = continuationProvider(requests);
        const originalSelection = {
            providerID: 'openai',
            modelID: 'gpt-4.1',
        };
        const firstProcess = createDesktopSessionCommandService({
            dataDir,
            workspaceRoot,
            now: fixedNow,
            provider,
            modelProviderSelection: defaultModelProviderSelection,
        });

        try {
            await firstProcess.submitPrompt({
                sessionId: 'session_desktop_continue',
                prompt: 'patch then continue',
                modelProviderSelection: originalSelection,
            });
            const restartedProcess = createDesktopSessionCommandService({
                dataDir,
                workspaceRoot,
                now: fixedNow,
                provider,
                modelProviderSelection: defaultModelProviderSelection,
            });

            // When
            const receipt = await restartedProcess.decideApproval({
                sessionId: 'session_desktop_continue',
                approvalId: 'approval_permission_call_patch_continue',
                state: 'approved',
                reason: 'desktop approved continuation',
            });

            // Then
            const replay = await readReplay(dataDir, 'session_desktop_continue');
            expect(receipt.status).toBe('completed');
            expect(receipt.eventsWritten).toBeGreaterThan(0);
            expect(requests).toHaveLength(2);
            expect(requests[0]).toMatchObject(originalSelection);
            expect(requests[1]).toMatchObject(originalSelection);
            expect(requests[1]?.messages.map((message) => message.role)).toEqual(['user', 'assistant', 'tool']);
            expect(requests[1]?.messages.find((message) => message.role === 'tool')).toMatchObject({
                toolCallId: 'call_patch_continue',
                status: 'completed',
            });
            expect(replay.events.map((event) => event.type)).toEqual(
                expect.arrayContaining(['tool.completed', 'model.call.completed', 'run.completed']),
            );
            expect(replay.events.at(-1)).toMatchObject({ type: 'run.completed' });
            expect(continuedMessage(replay.events)).toBe('continued after completed tool result');
        } finally {
            await rm(dataDir, { recursive: true, force: true });
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

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
            expect(lastEventOfType(replay.events, 'model.call.failed')?.message).toBe('provider continuation failed');
        } finally {
            await rm(dataDir, { recursive: true, force: true });
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });

    it('completes approved settlement without resuming when no provider continuation transcript exists', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'mctrl-desktop-no-continuation-'));
        const workspaceRoot = await mkdtemp(join(tmpdir(), 'mctrl-desktop-no-continuation-workspace-'));
        const providerRequests: ProviderTurnRequest[] = [];
        const provider = unexpectedResumeProvider(providerRequests);
        const sessionId = 'session_desktop_no_continuation';
        const store = await JsonlSessionEventStore.open({ dataDir, sessionId, now: fixedNow });

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
                    requestId: 'request_no_continuation',
                    sequence: 1,
                    toolCall: {
                        toolCallId: 'call_patch_no_continuation',
                        toolName: 'file.patch',
                        argumentsJson: JSON.stringify({
                            patch: [
                                'diff --git a/.no-continuation.txt b/.no-continuation.txt',
                                '--- /dev/null',
                                '+++ b/.no-continuation.txt',
                                '@@ -0,0 +1 @@',
                                '+completed without resume',
                                '',
                            ].join('\n'),
                        }),
                    },
                },
            });
            await store.append({
                type: 'permission.requested',
                timestamp: fixedNow(),
                sessionId,
                message: 'permission requested: file.patch',
                nativeSidecarStatus: 'mock',
                modelProviderSelection: defaultModelProviderSelection,
                permissionRequest: {
                    id: 'permission_call_patch_no_continuation',
                    action: 'file.patch',
                    reason: 'approve file.patch',
                },
                permissionDecision: {
                    requestId: 'permission_call_patch_no_continuation',
                    status: 'requires_approval',
                    reason: 'approval required',
                },
            });
            await store.append({
                type: 'approval.requested',
                timestamp: fixedNow(),
                sessionId,
                message: 'approval requested: file.patch',
                nativeSidecarStatus: 'mock',
                modelProviderSelection: defaultModelProviderSelection,
                approvalRecord: {
                    approvalId: 'approval_permission_call_patch_no_continuation',
                    requestId: 'permission_call_patch_no_continuation',
                    policyDecision: 'requires_approval',
                    state: 'pending',
                    subject: { kind: 'tool', id: 'file.patch' },
                    requestedAt: fixedNow(),
                    reason: 'approve file.patch',
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
                    runId: 'run_no_continuation',
                    reason: 'waiting for approval: file.patch',
                    toolCallId: 'call_patch_no_continuation',
                },
            });
        } finally {
            await store.close();
        }

        try {
            const service = createDesktopSessionCommandService({
                dataDir,
                workspaceRoot,
                now: fixedNow,
                provider,
                modelProviderSelection: defaultModelProviderSelection,
            });

            const receipt = await service.decideApproval({
                sessionId,
                approvalId: 'approval_permission_call_patch_no_continuation',
                state: 'approved',
                reason: 'desktop approved no continuation',
            });

            const replay = await readReplay(dataDir, sessionId);
            expect(receipt.status).toBe('completed');
            expect(providerRequests).toHaveLength(0);
            expect(replay.events.map((event) => event.type)).toEqual(
                expect.arrayContaining(['approval.updated', 'approval.resumed', 'file.diff.applied', 'tool.completed']),
            );
            expect(replay.events.map((event) => event.type)).not.toContain('run.failed');
        } finally {
            await rm(dataDir, { recursive: true, force: true });
            await rm(workspaceRoot, { recursive: true, force: true });
        }
    });
});

function continuationProvider(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
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
                        messageId: 'assistant_needs_patch',
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
            const toolResult = request.messages.find((message) => message.role === 'tool');
            yield {
                kind: 'response_completed',
                requestId: request.requestId,
                sequence: 1,
                message: {
                    messageId: 'assistant_after_patch',
                    role: 'assistant',
                    content: `continued after ${toolResult?.status ?? 'missing'} tool result`,
                },
                finishReason: 'stop',
            };
        },
    };
}

function failedContinuationProvider(): ProviderAdapter {
    const requests: ProviderTurnRequest[] = [];
    return {
        async *streamTurn(request) {
            requests.push(request);
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

function unexpectedResumeProvider(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            yield {
                kind: 'response_failed',
                requestId: request.requestId,
                sequence: 1,
                error: {
                    code: 'unknown',
                    message: 'resume should not have been called',
                    retryable: false,
                },
            };
        },
    };
}

function continuedMessage(events: Awaited<ReturnType<typeof readReplay>>['events']): string | undefined {
    return events.find(
        (event) => event.providerStreamChunk?.kind === 'response_completed' && event.message?.startsWith('continued'),
    )?.message;
}

function lastEventOfType(
    events: Awaited<ReturnType<typeof readReplay>>['events'],
    type: Awaited<ReturnType<typeof readReplay>>['events'][number]['type'],
) {
    return [...events].reverse().find((event) => event.type === type);
}
