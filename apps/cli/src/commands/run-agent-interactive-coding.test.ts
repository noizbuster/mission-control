import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createDeterministicProvider,
    type ProviderAdapter,
    type ProviderTurnRequest,
    projectJsonlSessionReplayPrefix,
} from '@mission-control/core';
import { type AgentEvent, type ProviderStreamChunk } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support.js';
import { replayedMessages, replayedTypes } from './session-replay-test-support.js';
import { writeSessionEvents } from './session-test-support.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent interactive coding agent UX', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('streams provider chunks and persists a durable final message for resumed sessions', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_stream']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'stream a provider turn' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([
                { kind: 'text_delta', delta: 'stream ' },
                { kind: 'text_delta', delta: 'chunk' },
                { kind: 'response_completed', content: 'stream final' },
            ]),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        // Then
        expect(output).toContain('resumed session: session_task20_stream');
        expect(output).toContain('provider: local');
        expect(output).toContain('model: local-echo');
        expect(output).toContain('selection: local/local-echo');
        expect(output).toContain('Assistant: stream chunk');
        // The durable final message is the streamed assistant text. The graph persists the turn's
        // accumulated deltas ('stream chunk'); the deterministic fixture's response_completed content
        // ('stream final') deliberately differs from its deltas, so the streamed text is the
        // engine-stable value (a real provider's completed content equals its streamed text).
        expect(await replayedMessages('session_task20_stream')).toEqual(expect.arrayContaining(['stream chunk']));
    });

    it('blocks file.patch when approval is denied and leaves the workspace unchanged', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        const workspaceRoot = await tempRoot('mctrl-chat-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_deny']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'make a deterministic patch proposal' },
                { type: 'line', value: 'n' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            provider: createDeterministicProvider([
                { kind: 'text_delta', delta: 'I can patch this.' },
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'patch_call',
                    toolName: 'file.patch',
                    argumentsJson: JSON.stringify({ patch: addFilePatch('.mctrl-task20.txt', 'denied') }),
                },
                { kind: 'response_completed', content: 'patch proposed' },
            ]),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        // Then
        expect(output).toContain('Approve file.patch? [once/always/deny]:');
        expect(output).toContain('Denied file.patch');
        // On the graph a denial is terminal: the tool settles `approval_denied` and the run fails
        // (the graph's documented deny semantics) rather than flat's resumable block.
        expect(output).toContain('file.patch failed: approval_denied');
        expect(events.some((event) => event.type === 'task.failed')).toBe(true);
        await expect(readFile(join(workspaceRoot, '.mctrl-task20.txt'), 'utf8')).rejects.toThrow();
    });

    it('applies approved patches and renders captured command output plainly', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        const workspaceRoot = await tempRoot('mctrl-chat-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();
        const requests: ProviderTurnRequest[] = [];
        const events: AgentEvent[] = [];

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_allow']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'make a deterministic patch proposal and run the test' },
                { type: 'line', value: 'y' },
                { type: 'line', value: 'y' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            commandExecutor: fakeCommandExecutor,
            provider: providerFromApprovedToolRequests(requests),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        // Then
        expect(requests).toHaveLength(2);
        expect(output).toContain('Applied patch: .mctrl-task20.txt');
        // Serialization proof: a multi-tool batch (file.patch + command.run proposed in ONE step)
        // presented each approval one at a time — neither was auto-denied by the approval broker's
        // single-pending invariant. This is the blocker the interactive-default flip had to close
        // (without serialized execution the 2nd concurrent approval would be denied and the run would
        // terminate before finalize).
        expect(output).toContain('Approved once file.patch');
        expect(output).toContain('Approved once command.run');
        expect(output).not.toContain('another approval is already pending');
        expect(output).toContain('Command output for command.run');
        expect(output).toContain('stdout:\ntask20 ok');
        expect(output).toContain('Assistant: patch and test complete');
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['run.completed']));
        expect(events.some((event) => event.type === 'run.blocked')).toBe(false);
        expect(await readFile(join(workspaceRoot, '.mctrl-task20.txt'), 'utf8')).toBe('approved\n');
    });

    it('continues after a read tool result and renders the final provider answer', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        const workspaceRoot = await tempRoot('mctrl-chat-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await writeFixtureFile(workspaceRoot, 'README.md', 'tool result from workspace\n');
        const chatOutput = createBufferedChatOutput();
        const requests: ProviderTurnRequest[] = [];

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_continuation']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'read the readme and summarize it' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            provider: providerFromTurnRequests(requests),
        });

        // Then
        expect(requests).toHaveLength(2);
        expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(
            expect.arrayContaining(['read', 'ls', 'grep', 'find', 'file.edit', 'file.patch', 'command.run']),
        );
        // The exact `request.messages` array is engine-specific (the graph seeds its own ABG persona
        // `[system, …]`); the rendered final answer is the engine-agnostic continuation proof.
        expect(output).toContain('Assistant: final summary saw tool result from workspace');
    });

    it('admits queue, steer, resume, branch continue, and interrupts an active provider turn', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_control']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'start a slow provider turn' },
                { type: 'line', value: '/queue follow up after tools' },
                { type: 'line', value: '/steer adjust the current run' },
                { type: 'line', value: '/branch message_parent continue from this branch' },
                { type: 'line', value: '/resume' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([
                { kind: 'wait', ms: 30_000 },
                { kind: 'response_completed', content: 'too late' },
            ]),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        // Then
        expect(output).toContain('Queued follow-up: follow up after tools');
        expect(output).toContain('Steering current run: adjust the current run');
        expect(output).toContain('Branch continue from message_parent: continue from this branch');
        expect(output).toContain('Resume requested for session_task20_control');
        expect(output).toContain('Interrupted active run');
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'prompt.admitted',
                transcript: expect.objectContaining({ delivery: 'queue' }),
            }),
        );
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'prompt.admitted',
                transcript: expect.objectContaining({
                    delivery: 'steer',
                    parentMessageId: 'message_parent',
                }),
            }),
        );
        const replayTypes = await replayedTypes('session_task20_control');
        expect(replayTypes).toEqual(expect.arrayContaining(['run.interrupted']));
        expect(replayTypes).not.toContain('run.completed');
    });

    it('requires two idle Ctrl+C interrupts after stopping an active provider turn', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_interrupt_then_exit']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'start a slow provider turn' },
                { type: 'interrupt' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([
                { kind: 'wait', ms: 30_000 },
                { kind: 'response_completed', content: 'too late' },
            ]),
        });

        // Then
        expect(output).toContain('Interrupted active run');
        expect(output).toContain('Press Ctrl+C twice to exit');
        expect(output.match(/Press Ctrl\+C again to exit/g)).toHaveLength(1);
        expect(output).not.toContain('too late');
        const replayTypes = await replayedTypes('session_task20_interrupt_then_exit');
        expect(replayTypes).toEqual(expect.arrayContaining(['run.interrupted']));
        expect(replayTypes).not.toContain('run.completed');
    });

    it('navigates durable sessions with tree, branch, fork, clone, and list commands', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await writeSessionEvents({
            dataDir,
            sessionId: 'session_navigation_source',
            events: [
                sessionEvent('session_navigation_source', 'session.started', 'seeded navigation source'),
                sessionEvent('session_navigation_source', 'task.completed', 'root prompt', {
                    kind: 'entry',
                    entryId: 'entry_root',
                }),
                sessionEvent('session_navigation_source', 'task.completed', 'branch reply', {
                    kind: 'entry',
                    entryId: 'entry_branch',
                    parentEntryId: 'entry_root',
                    active: true,
                }),
            ],
        });
        const chatOutput = createBufferedChatOutput();

        // When
        const output = await runAgent(parseArgs(['--session', 'session_navigation_source']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/tree' },
                { type: 'line', value: '/branch entry_root' },
                { type: 'line', value: '/fork entry_root session_navigation_fork' },
                { type: 'line', value: '/clone session_navigation_clone' },
                { type: 'line', value: '/sessions' },
                { type: 'line', value: '/session session_navigation_source' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([]),
        });
        const forkReplay = projectJsonlSessionReplayPrefix({
            sessionId: 'session_navigation_fork',
            contents: await readFile(join(dataDir, 'sessions', 'session_navigation_fork.jsonl'), 'utf8'),
        }).projection;
        const cloneReplay = projectJsonlSessionReplayPrefix({
            sessionId: 'session_navigation_clone',
            contents: await readFile(join(dataDir, 'sessions', 'session_navigation_clone.jsonl'), 'utf8'),
        }).projection;
        const sourceReplay = projectJsonlSessionReplayPrefix({
            sessionId: 'session_navigation_source',
            contents: await readFile(join(dataDir, 'sessions', 'session_navigation_source.jsonl'), 'utf8'),
        }).projection;

        // Then
        expect(output).toContain('Session tree: session_navigation_source');
        expect(output).toContain('*     entry_branch branch reply');
        expect(output).toContain('Active branch: entry_root');
        expect(output).toContain('Forked session: session_navigation_fork from entry_root');
        expect(output).toContain('Cloned session: session_navigation_clone');
        expect(output).toContain('* session_navigation_clone');
        expect(output).toContain('Switched to session: session_navigation_source');
        expect(forkReplay.snapshot.sessionId).toBe('session_navigation_fork');
        expect(forkReplay.snapshot.status).toBe('running');
        expect(forkReplay.sessionTree.forkSource).toEqual({
            sessionId: 'session_navigation_source',
            entryId: 'entry_root',
        });
        expect(forkReplay.sessionTree.activeLeafId).toBe('entry_root');
        expect(cloneReplay.sessionTree.cloneSource).toEqual({
            sessionId: 'session_navigation_fork',
            entryId: 'entry_root',
        });
        expect(cloneReplay.snapshot.status).toBe('running');
        expect(sourceReplay.snapshot.sessionId).toBe('session_navigation_source');
        expect(sourceReplay.sessionTree.activeLeafId).toBe('entry_root');
    });

    it('exits and force-stops an active provider turn with /exit', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_exit']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'start a child run' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: chatOutput.output,
            provider: createDeterministicProvider([
                { kind: 'wait', ms: 30_000 },
                { kind: 'response_completed', content: 'too late' },
            ]),
        });

        // Then
        expect(output).toContain('Interrupted active run');
        expect(output).toContain('Exiting mission-control chat');
        expect(output).not.toContain('too late');
        expect(await replayedTypes('session_task20_exit')).toEqual(expect.arrayContaining(['run.interrupted']));
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

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

async function fakeCommandExecutor(_request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'task20 ok\n',
        stderr: '',
        durationMs: 1,
    };
}

async function writeFixtureFile(workspaceRoot: string, path: string, content: string): Promise<void> {
    await writeFile(join(workspaceRoot, path), content);
}

function providerFromApprovedToolRequests(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            if (requests.length === 1) {
                yield {
                    kind: 'tool_call_completed',
                    requestId: request.requestId,
                    sequence: 1,
                    toolCall: {
                        toolCallId: 'patch_call',
                        toolName: 'file.patch',
                        argumentsJson: JSON.stringify({ patch: addFilePatch('.mctrl-task20.txt', 'approved') }),
                    },
                };
                yield {
                    kind: 'tool_call_completed',
                    requestId: request.requestId,
                    sequence: 2,
                    toolCall: {
                        toolCallId: 'command_call',
                        toolName: 'command.run',
                        argumentsJson: JSON.stringify({
                            command: 'node',
                            args: ['--eval', "console.log('mission-control command.run harness ok')"],
                        }),
                    },
                };
                yield cliCompletedChunk(request, 'tools requested', ['patch_call', 'command_call']);
                return;
            }
            yield cliCompletedChunk(request, 'patch and test complete');
        },
    };
}

function providerFromTurnRequests(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            if (requests.length === 1) {
                yield cliToolCallChunk(request);
                yield cliCompletedChunk(request, 'reading README', ['read_call_cli']);
                return;
            }
            const toolMessage = request.messages.find((message) => message.role === 'tool');
            yield cliCompletedChunk(request, `final summary saw ${lastNonEmptyLine(toolMessage?.output)}`);
        },
    };
}

function lastNonEmptyLine(value: string | undefined): string {
    if (value === undefined) {
        return 'missing tool output';
    }
    const lines = value.split(/\r?\n/).filter((line) => line.trim().length > 0);
    return lines.at(-1)?.trim() ?? 'missing tool output';
}

function cliToolCallChunk(request: ProviderTurnRequest): ProviderStreamChunk {
    return {
        kind: 'tool_call_completed',
        requestId: request.requestId,
        sequence: 1,
        toolCall: {
            toolCallId: 'read_call_cli',
            toolName: 'read',
            argumentsJson: JSON.stringify({ path: 'README.md' }),
        },
    };
}

function cliCompletedChunk(
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
