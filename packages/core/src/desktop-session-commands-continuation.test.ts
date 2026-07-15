import { defaultModelProviderSelection } from '@mission-control/config';
import { describe, expect, it } from 'vitest';
import { createDesktopSessionCommandService } from './desktop-session-commands';
import { filePatchCall, fixedNow, readReplay } from './desktop-session-commands-test-support';
import type { ProviderAdapter, ProviderTurnRequest } from './providers/provider-turn-types';
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
            // The graph seed leads with the ABG system persona; assert each expected role is
            // present rather than exact-array (graph emits extra messages across approval boundaries).
            const resumeRoles = requests[1]?.messages.map((message) => message.role) ?? [];
            expect(resumeRoles).toContain('user');
            expect(resumeRoles).toContain('assistant');
            expect(resumeRoles).toContain('tool');
            expect(requests[1]?.messages.find((message) => message.role === 'tool')).toMatchObject({
                toolCallId: 'call_patch_continue',
                status: 'completed',
            });
            expect(replay.events.map((event) => event.type)).toEqual(
                expect.arrayContaining(['tool.completed', 'model.call.completed', 'run.completed']),
            );
            expect(replay.events.at(-1)).toMatchObject({ type: 'run.completed' });
            expect(continuedAssistantMessage(replay.events)).toBe('continued after completed tool result');
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

function continuedAssistantMessage(events: Awaited<ReturnType<typeof readReplay>>['events']): string | undefined {
    // The graph carries the model's final assistant text on `model.call.completed.message`
    // (the flat path carried it on `providerStreamChunk.message.content`).
    return events
        .filter((event) => event.type === 'model.call.completed')
        .reverse()
        .find((event) => (event.message ?? '').startsWith('continued'))?.message;
}
