import type { AgentEvent, ModelProviderSelection, ProviderStreamChunk } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { projectApprovalContinuationMessages } from '../desktop-approval-transcript.js';
import { JsonlSessionEventStore } from '../memory/jsonl-session-event-store.js';
import type { ProviderAdapter, ProviderTurnRequest } from '../providers/provider-turn-types.js';
import { SessionRunOwnerRegistry } from './run-owner.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];
const selection: ModelProviderSelection = { providerID: 'local', modelID: 'deterministic' };

afterEach(async () => {
    for (const dataDir of tempDirs.splice(0)) {
        await rm(dataDir, { recursive: true, force: true });
    }
});

describe('SessionRunOwnerRegistry approval resume', () => {
    it('resumes a blocked tool continuation after the tool result is durably recorded', async () => {
        const dataDir = await makeDataDir('mission-control-run-owner-blocked-resume-');
        const sessionId = 'session_owner_blocked_resume';
        const requests: ProviderTurnRequest[] = [];
        const registry = new SessionRunOwnerRegistry({
            dataDir,
            provider: blockedThenContinuedProvider(requests),
            modelProviderSelection: selection,
            now: fixedNow,
            createEventId: (_event: AgentEvent, sequence: number) => `event_${sequence}`,
            createId: (prefix, index) => `${prefix}_${index}`,
        });

        const blocked = await registry.submit({
            sessionId,
            inputId: 'input_blocked',
            messageId: 'message_blocked',
            prompt: 'apply the patch',
        });
        await appendApprovedToolResult(dataDir, sessionId);
        let activeStore: JsonlSessionEventStore | undefined;
        const resumed = await registry.withOwner(
            {
                sessionId,
                readMessages: async () => {
                    if (activeStore === undefined) {
                        throw new TypeError('resume requested before the session store was attached');
                    }
                    return projectApprovalContinuationMessages(await activeStore.getEvents(sessionId), sessionId);
                },
            },
            async (owner, store) => {
                activeStore = store;
                return owner.resume();
            },
        );
        const events = await readEvents(dataDir, sessionId);

        expect(blocked).toMatchObject({
            sessionId,
            status: 'blocked_on_approval',
            runId: 'run_1',
            toolCallId: 'blocked_patch_call',
        });
        expect(resumed).toMatchObject({ sessionId, status: 'completed', runId: 'run_1' });
        expect(requests).toHaveLength(2);
        expect(requests[1]?.messages).toEqual([
            { role: 'user', content: 'apply the patch' },
            {
                role: 'assistant',
                content: 'approval required',
                providerToolCalls: [
                    {
                        providerID: 'local',
                        toolCallId: 'blocked_patch_call',
                        toolName: 'file.patch',
                        argumentsJson: JSON.stringify({
                            patch: addFilePatch('.blocked.txt', 'approved'),
                        }),
                    },
                ],
            },
            {
                role: 'tool',
                toolCallId: 'blocked_patch_call',
                status: 'completed',
                output: 'applied patch to .blocked.txt',
            },
        ]);
        expect(events.find((event) => event.type === 'run.blocked')?.run).toMatchObject({
            runId: 'run_1',
            state: 'blocked_on_approval',
            toolCallId: 'blocked_patch_call',
        });
        expect(
            events.find((event) => event.type === 'run.command.received' && event.run?.command === 'resume')?.run,
        ).toMatchObject({
            command: 'resume',
            state: 'blocked_on_approval',
            runId: 'run_1',
            reason: 'waiting for approval: file.patch',
            errorCode: 'tool_failed',
            toolCallId: 'blocked_patch_call',
        });
        expect(lastEventOfType(events, 'run.completed')?.run).toMatchObject({
            command: 'resume',
            state: 'completed',
            runId: 'run_1',
        });
    });
});

function blockedThenContinuedProvider(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            if (requests.length === 1) {
                yield toolCallChunk(request, 'blocked_patch_call', 'file.patch', {
                    patch: addFilePatch('.blocked.txt', 'approved'),
                });
                yield completedChunk(request, 'approval required', ['blocked_patch_call']);
                return;
            }
            yield completedChunk(request, 'continued after approval');
        },
    };
}

async function appendApprovedToolResult(dataDir: string, sessionId: string): Promise<void> {
    const store = await JsonlSessionEventStore.open({
        dataDir,
        sessionId,
        now: fixedNow,
        createEventId: (_event: AgentEvent, sequence: number) => `append_event_${sequence}`,
    });
    try {
        await store.append({
            type: 'approval.updated',
            timestamp: fixedNow(),
            sessionId,
            message: 'approval updated: approved',
            approvalRecord: {
                approvalId: 'approval_blocked_patch_call',
                requestId: 'approval_blocked_patch_call',
                state: 'approved',
                requestedAt: fixedNow(),
                decidedAt: fixedNow(),
                reason: 'approved for resume',
                subject: {
                    kind: 'tool',
                    id: 'blocked_patch_call',
                },
                policyDecision: 'requires_approval',
            },
        });
        await store.append({
            type: 'tool.completed',
            timestamp: fixedNow(),
            sessionId,
            taskId: 'blocked_patch_call',
            message: 'tool completed: file.patch',
            toolResult: {
                toolCallId: 'blocked_patch_call',
                status: 'completed',
                output: 'applied patch to .blocked.txt',
            },
        });
    } finally {
        await store.close();
    }
}

async function makeDataDir(prefix: string): Promise<string> {
    const dataDir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dataDir);
    return dataDir;
}

async function readEvents(dataDir: string, sessionId: string): Promise<readonly AgentEvent[]> {
    const store = await JsonlSessionEventStore.open({
        sessionId,
        dataDir,
        now: fixedNow,
        createEventId: (_event: AgentEvent, sequence: number) => `read_event_${sequence}`,
    });
    try {
        return await store.getEvents(sessionId);
    } finally {
        await store.close();
    }
}

function toolCallChunk(
    request: ProviderTurnRequest,
    toolCallId: string,
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
): ProviderStreamChunk {
    return {
        kind: 'tool_call_completed',
        requestId: request.requestId,
        sequence: 1,
        toolCall: {
            toolCallId,
            toolName,
            argumentsJson: JSON.stringify(argumentsValue),
        },
    };
}

function completedChunk(
    request: ProviderTurnRequest,
    content: string,
    toolCallIds?: readonly string[],
): ProviderStreamChunk {
    return {
        kind: 'response_completed',
        requestId: request.requestId,
        sequence: 2,
        message: {
            messageId: `message_${request.turnId}`,
            role: 'assistant',
            content,
            ...(toolCallIds !== undefined ? { toolCallIds: [...toolCallIds] } : {}),
        },
        finishReason: toolCallIds === undefined ? 'stop' : 'tool_calls',
    };
}

function fixedNow(): string {
    return '2026-06-13T00:00:00.000Z';
}

function lastEventOfType(events: readonly AgentEvent[], type: AgentEvent['type']): AgentEvent | undefined {
    return [...events].reverse().find((event) => event.type === type);
}

function addFilePatch(path: string, content: string): string {
    return [
        `diff --git a/${path} b/${path}`,
        '--- /dev/null',
        `+++ b/${path}`,
        '@@ -0,0 +1 @@',
        `+${content}`,
        '',
    ].join('\n');
}
