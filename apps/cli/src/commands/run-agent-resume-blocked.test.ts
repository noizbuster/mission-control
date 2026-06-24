import { createDeterministicProvider, JsonlSessionEventStore } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent interactive resume for blocked runs', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('resumes a previously blocked tool continuation for the same durable session', async () => {
        const dataDir = await tempRoot('mctrl-chat-resume-data-');
        const sessionId = 'session_cli_resume_blocked';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await seedBlockedSession(dataDir, sessionId);
        const events: AgentEvent[] = [];
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs(['--session', sessionId]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput(
                [{ type: 'line', value: '/resume' }, { type: 'interrupt' }, { type: 'interrupt' }],
                50,
            ),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([
                { kind: 'response_completed', content: 'final after applied patch' },
            ]),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        expect(output).toContain('Resuming blocked run for session_cli_resume_blocked');
        expect(output).toContain('Assistant: final after applied patch');
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'run.completed',
                run: expect.objectContaining({ command: 'resume', state: 'completed', runId: 'run_seed' }),
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'run.command.received',
                run: expect.objectContaining({
                    command: 'resume',
                    state: 'blocked_on_approval',
                    runId: 'run_seed',
                    reason: 'waiting for approval: file.patch',
                    errorCode: 'tool_failed',
                    toolCallId: 'seed_patch_call',
                }),
            }),
        );
        expect(events.some((event) => event.type === 'task.failed')).toBe(false);
        const replay = await replayEvents(dataDir, sessionId);
        expect(replay.find((event) => event.type === 'run.blocked')?.run).toMatchObject({
            state: 'blocked_on_approval',
            runId: 'run_seed',
            toolCallId: 'seed_patch_call',
        });
        expect(lastEventOfType(replay, 'run.completed')?.run).toMatchObject({
            command: 'resume',
            state: 'completed',
            runId: 'run_seed',
        });
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

async function seedBlockedSession(dataDir: string, sessionId: string): Promise<void> {
    const store = await JsonlSessionEventStore.open({
        dataDir,
        sessionId,
        now: fixedNow,
        createEventId: (_event, sequence) => `event_${sequence}`,
    });
    try {
        const events: AgentEvent[] = [
            {
                type: 'session.started',
                timestamp: fixedNow(),
                sessionId,
                message: 'seed session started',
                nativeSidecarStatus: 'mock',
            },
            {
                type: 'prompt.admitted',
                timestamp: fixedNow(),
                sessionId,
                message: 'apply a patch',
                transcript: {
                    inputId: 'input_seed',
                    messageId: 'message_seed',
                    delivery: 'steer',
                    visibility: 'pending',
                },
            },
            {
                type: 'prompt.promoted',
                timestamp: fixedNow(),
                sessionId,
                message: 'apply a patch',
                transcript: {
                    inputId: 'input_seed',
                    messageId: 'message_seed',
                    delivery: 'steer',
                    visibility: 'model_visible',
                },
            },
            {
                type: 'model.call.started',
                timestamp: fixedNow(),
                sessionId,
                taskId: 'turn_seed',
                message: 'model call started',
            },
            {
                type: 'model.call.completed',
                timestamp: fixedNow(),
                sessionId,
                taskId: 'turn_seed',
                message: 'approval required',
                providerStreamChunk: {
                    kind: 'tool_call_completed',
                    requestId: 'request_seed',
                    sequence: 0,
                    toolCall: {
                        toolCallId: 'seed_patch_call',
                        toolName: 'file.patch',
                        argumentsJson: JSON.stringify({
                            patch: addFilePatch('.seed.txt', 'approved'),
                        }),
                    },
                },
            },
            {
                type: 'model.call.completed',
                timestamp: fixedNow(),
                sessionId,
                taskId: 'turn_seed',
                message: 'approval required',
                providerStreamChunk: {
                    kind: 'response_completed',
                    requestId: 'request_seed',
                    sequence: 1,
                    message: {
                        messageId: 'assistant_seed',
                        role: 'assistant',
                        content: 'approval required',
                        toolCallIds: ['seed_patch_call'],
                    },
                    finishReason: 'tool_calls',
                },
            },
            {
                type: 'run.blocked',
                timestamp: fixedNow(),
                sessionId,
                message: 'waiting for approval: file.patch',
                run: {
                    command: 'run',
                    state: 'blocked_on_approval',
                    runId: 'run_seed',
                    reason: 'waiting for approval: file.patch',
                    errorCode: 'tool_failed',
                    toolCallId: 'seed_patch_call',
                },
            },
            {
                type: 'approval.updated',
                timestamp: fixedNow(),
                sessionId,
                message: 'approval updated: approved',
                approvalRecord: {
                    approvalId: 'approval_seed_patch_call',
                    requestId: 'approval_seed_patch_call',
                    state: 'approved',
                    requestedAt: fixedNow(),
                    decidedAt: fixedNow(),
                    reason: 'approved externally',
                    subject: {
                        kind: 'tool',
                        id: 'seed_patch_call',
                    },
                    policyDecision: 'requires_approval',
                },
            },
            {
                type: 'tool.completed',
                timestamp: fixedNow(),
                sessionId,
                taskId: 'seed_patch_call',
                message: 'tool completed: file.patch',
                toolResult: {
                    toolCallId: 'seed_patch_call',
                    status: 'completed',
                    output: 'applied patch to .seed.txt',
                },
            },
        ];

        for (const event of events) {
            await store.append(event);
        }
    } finally {
        await store.close();
    }
}

function fixedNow(): string {
    return '2026-06-13T00:00:00.000Z';
}

async function replayEvents(dataDir: string, sessionId: string): Promise<readonly AgentEvent[]> {
    const store = await JsonlSessionEventStore.open({
        dataDir,
        sessionId,
        now: fixedNow,
        createEventId: (_event, sequence) => `read_event_${sequence}`,
    });
    try {
        return await store.getEvents(sessionId);
    } finally {
        await store.close();
    }
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

function lastEventOfType(events: readonly AgentEvent[], type: AgentEvent['type']): AgentEvent | undefined {
    for (let index = events.length - 1; index >= 0; index -= 1) {
        const event = events[index];
        if (event?.type === type) {
            return event;
        }
    }
    return undefined;
}
