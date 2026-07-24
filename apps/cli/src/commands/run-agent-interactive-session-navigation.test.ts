import {
    createDeterministicProvider,
    ProjectTrustStore,
    type ProviderAdapter,
    type ProviderTurnRequest,
} from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { runAgent } from './run-agent';
import { createBufferedChatOutput, createEmptyAuthStore, createScriptedChatInput } from './run-agent-chat-test-support';
import { readStoredSessionProjection, writeLocalSessionEvents } from './session-test-support';
import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent interactive session navigation repairs', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('gates current-session navigation until a durable session is created with /new', async () => {
        const dataDir = await tempRoot('mctrl-chat-navigation-data-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/tree' },
                { type: 'line', value: '/new session_navigation_live' },
                { type: 'line', value: '/tree' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([]),
        });

        expect(output).toContain('No active session yet — send a prompt first.');
        expect(output).toContain('Started new session: session_navigation_live');
        expect(output).toContain('Session tree: session_navigation_live');
    });

    it('switches a SQLite session even when a stale corrupt legacy JSONL side file shares the id', async () => {
        const dataDir = await tempRoot('mctrl-chat-navigation-corrupt-');
        const sessionId = 'session_navigation_corrupt';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await writeLocalSessionEvents({
            dataDir,
            sessionId,
            events: [
                sessionEvent(sessionId, 'task.completed', 'root prompt', { kind: 'entry', entryId: 'entry_root' }),
            ],
        });
        await mkdir(join(dataDir, 'sessions'), { recursive: true });
        await appendFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), '{"corrupt":true}\n', 'utf8');
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: `/session ${sessionId}` },
                { type: 'line', value: '/sessions' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([]),
        });

        expect(output).toContain(sessionId);
        expect(output).not.toContain(`Cannot switch corrupt session: ${sessionId}`);
        expect(output).toContain('Exiting mission-control chat');
    });

    it('attaches a terminal session with incomplete provider continuation diagnostics', async () => {
        const dataDir = await tempRoot('mctrl-chat-navigation-incomplete-continuation-');
        const sessionId = 'session_navigation_incomplete_continuation';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await writeLocalSessionEvents({
            dataDir,
            sessionId,
            events: [
                sessionEvent(sessionId, 'session.started', 'failed source'),
                sessionEvent(sessionId, 'prompt.promoted', 'restore failed work'),
                uncontinuedToolFailureEvent(sessionId),
                failedGraphEvent(sessionId),
                sessionEvent(sessionId, 'session.stopped', 'failed source stopped'),
            ],
        });
        const before = await readStoredSessionProjection({ dataDir, sessionId });
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs([]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: `/session ${sessionId}` },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([]),
        });

        const after = await readStoredSessionProjection({ dataDir, sessionId });
        expect(output).toContain(`Switched to session: ${sessionId}`);
        expect(output).not.toContain(`Cannot switch corrupt session: ${sessionId}`);
        expect(after.events).toEqual(before.events);
    });

    it('attaches a terminal failed session without rewriting its lifecycle when no new work runs', async () => {
        const dataDir = await tempRoot('mctrl-chat-navigation-terminal-attach-');
        const sessionId = 'session_navigation_terminal_attach';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await writeLocalSessionEvents({
            dataDir,
            sessionId,
            events: [
                sessionEvent(sessionId, 'session.started', 'failed source'),
                sessionEvent(sessionId, 'prompt.promoted', 'restore failed work'),
                failedGraphEvent(sessionId),
            ],
        });
        const before = await readStoredSessionProjection({ dataDir, sessionId });
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs(['--session', sessionId]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([{ type: 'line', value: '/exit' }]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([]),
        });

        const after = await readStoredSessionProjection({ dataDir, sessionId });
        expect(output).toContain('You: restore failed work');
        expect(after.events).toEqual(before.events);
    });

    it('accepts a new prompt after attaching a terminal failed session', async () => {
        const dataDir = await tempRoot('mctrl-chat-navigation-terminal-prompt-');
        const sessionId = 'session_navigation_terminal_prompt';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await writeLocalSessionEvents({
            dataDir,
            sessionId,
            events: [
                sessionEvent(sessionId, 'session.started', 'failed source'),
                sessionEvent(sessionId, 'prompt.promoted', 'restore failed work'),
                failedGraphEvent(sessionId),
            ],
        });
        const requests: ProviderTurnRequest[] = [];

        await runAgent(parseArgs(['--session', sessionId]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'continue from the attached failure' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: createBufferedChatOutput().output,
            provider: captureProvider(requests),
            plainPromptGraph: 'coding-agent',
        });

        const projection = await readStoredSessionProjection({ dataDir, sessionId });
        expect(requests).toHaveLength(1);
        expect(
            projection.events.some(
                (event) => event.type === 'prompt.admitted' && event.message === 'continue from the attached failure',
            ),
        ).toBe(true);
    });

    it('filters copied approval and tool state out of cloned sessions in the interactive surface', async () => {
        const dataDir = await tempRoot('mctrl-chat-navigation-blocked-');
        const sourceSessionId = 'session_navigation_blocked_source';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await writeLocalSessionEvents({
            dataDir,
            sessionId: sourceSessionId,
            events: [
                sessionEvent(sourceSessionId, 'session.started', 'blocked source'),
                sessionEvent(sourceSessionId, 'task.completed', 'root prompt', {
                    kind: 'entry',
                    entryId: 'entry_root',
                }),
                blockedRunEvent(sourceSessionId),
                approvalUpdatedEvent(sourceSessionId),
                toolCompletedEvent(sourceSessionId),
            ],
        });
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs(['--session', sourceSessionId]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/clone session_navigation_blocked_clone' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([]),
        });

        const cloneProjection = await readStoredSessionProjection({
            dataDir,
            sessionId: 'session_navigation_blocked_clone',
        });

        expect(output).toContain('Cloned session: session_navigation_blocked_clone');
        expect(cloneProjection.events.map((event) => event.type)).toEqual(
            expect.not.arrayContaining(['run.blocked', 'approval.updated', 'tool.completed']),
        );
    });

    it('keeps trusted execution tooling available after fork, clone, and session switch', async () => {
        const dataDir = await tempRoot('mctrl-chat-navigation-trust-data-');
        const workspaceRoot = await tempRoot('mctrl-chat-navigation-trust-workspace-');
        const sourceSessionId = 'session_navigation_trusted_source';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await new ProjectTrustStore({ dataDir }).setDecision(workspaceRoot, 'trusted');
        await writeLocalSessionEvents({
            dataDir,
            sessionId: sourceSessionId,
            events: [
                sessionEvent(sourceSessionId, 'session.started', 'trusted source'),
                sessionEvent(sourceSessionId, 'task.completed', 'root prompt', {
                    kind: 'entry',
                    entryId: 'entry_root',
                }),
            ],
        });
        const chatOutput = createBufferedChatOutput();
        const requests: ProviderTurnRequest[] = [];

        await runAgent(parseArgs(['--session', sourceSessionId]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput(
                [
                    { type: 'line', value: '/fork entry_root session_navigation_trusted_fork' },
                    { type: 'line', value: 'prompt after fork' },
                    { type: 'line', value: '/clone session_navigation_trusted_clone' },
                    { type: 'line', value: 'prompt after clone' },
                    { type: 'line', value: `/session ${sourceSessionId}` },
                    { type: 'line', value: 'prompt after switch' },
                    { type: 'line', value: '/exit' },
                ],
                50,
            ),
            chatOutput: chatOutput.output,
            provider: captureProvider(requests),
            workspaceRoot,
            plainPromptGraph: 'coding-agent',
        });

        expect(requests).toHaveLength(3);
        for (const request of requests) {
            expect(request.tools?.map((tool) => tool.name)).toContain('bash.run');
        }
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

function sessionEvent(
    sessionId: string,
    type: AgentEvent['type'],
    message: string,
    sessionTree?: AgentEvent['sessionTree'],
): AgentEvent {
    return {
        type,
        timestamp: '2026-06-13T01:00:00.000Z',
        sessionId,
        message,
        nativeSidecarStatus: 'mock',
        modelProviderSelection: {
            providerID: 'local',
            modelID: 'local-echo',
        },
        ...(sessionTree !== undefined ? { sessionTree } : {}),
    };
}

function failedGraphEvent(sessionId: string): AgentEvent {
    return {
        type: 'graph.failed',
        timestamp: '2026-06-13T01:00:02.000Z',
        sessionId,
        message: 'provider failure ended the graph',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: {
            providerID: 'local',
            modelID: 'local-echo',
        },
        abg: {
            graphId: 'default',
            error: {
                code: 'provider_timeout',
                message: 'provider failure ended the graph',
                retryable: false,
            },
        },
    };
}

function uncontinuedToolFailureEvent(sessionId: string): AgentEvent {
    return {
        type: 'tool.failed',
        timestamp: '2026-06-13T01:00:01.000Z',
        sessionId,
        taskId: 'call_incomplete',
        message: 'tool failed before the provider continuation',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: {
            providerID: 'local',
            modelID: 'local-echo',
        },
        toolResult: {
            toolCallId: 'call_incomplete',
            status: 'failed',
        },
    };
}

function blockedRunEvent(sessionId: string): AgentEvent {
    return {
        type: 'run.blocked',
        timestamp: '2026-06-13T01:00:00.000Z',
        sessionId,
        message: 'waiting for approval: file.patch',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: {
            providerID: 'local',
            modelID: 'local-echo',
        },
        run: {
            command: 'run',
            state: 'blocked_on_approval',
            runId: 'run_seed',
            reason: 'waiting for approval: file.patch',
            errorCode: 'tool_failed',
            toolCallId: 'seed_patch_call',
        },
    };
}

function approvalUpdatedEvent(sessionId: string): AgentEvent {
    return {
        type: 'approval.updated',
        timestamp: '2026-06-13T01:00:00.000Z',
        sessionId,
        message: 'approval updated: approved',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: {
            providerID: 'local',
            modelID: 'local-echo',
        },
        approvalRecord: {
            approvalId: 'approval_seed_patch_call',
            requestId: 'approval_seed_patch_call',
            state: 'approved',
            requestedAt: '2026-06-13T01:00:00.000Z',
            decidedAt: '2026-06-13T01:00:00.000Z',
            reason: 'approved externally',
            subject: {
                kind: 'tool',
                id: 'seed_patch_call',
            },
            policyDecision: 'requires_approval',
        },
    };
}

function toolCompletedEvent(sessionId: string): AgentEvent {
    return {
        type: 'tool.completed',
        timestamp: '2026-06-13T01:00:00.000Z',
        sessionId,
        taskId: 'seed_patch_call',
        message: 'tool completed: file.patch',
        nativeSidecarStatus: 'mock',
        modelProviderSelection: {
            providerID: 'local',
            modelID: 'local-echo',
        },
        toolResult: {
            toolCallId: 'seed_patch_call',
            status: 'completed',
            output: 'applied patch to .seed.txt',
        },
    };
}

function captureProvider(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            yield {
                kind: 'response_completed',
                requestId: request.requestId,
                sequence: 0,
                message: {
                    messageId: `message_${request.turnId}`,
                    role: 'assistant',
                    content: 'ok',
                },
                finishReason: 'stop',
            };
        },
    };
}
