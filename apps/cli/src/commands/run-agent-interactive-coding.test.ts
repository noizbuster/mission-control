import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createDeterministicProvider,
} from '@mission-control/core';
import { type AgentEvent, AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support.js';
import { runSessionCommand } from './session.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
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
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'model.call.completed',
                message: 'stream final',
            }),
        );
        expect(await replayedMessages('session_task20_stream')).toEqual(expect.arrayContaining(['stream final']));
    });

    it('blocks file.patch when approval is denied and leaves the workspace unchanged', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        const workspaceRoot = await tempRoot('mctrl-chat-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();

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
        });

        // Then
        expect(output).toContain('Patch preview for file.patch');
        expect(output).toContain('Approve file.patch? [y/N]:');
        expect(output).toContain('Denied file.patch');
        await expect(readFile(join(workspaceRoot, '.mctrl-task20.txt'), 'utf8')).rejects.toThrow();
    });

    it('applies approved patches and renders captured command output plainly', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        const workspaceRoot = await tempRoot('mctrl-chat-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();

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
            provider: createDeterministicProvider([
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'patch_call',
                    toolName: 'file.patch',
                    argumentsJson: JSON.stringify({ patch: addFilePatch('.mctrl-task20.txt', 'approved') }),
                },
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'command_call',
                    toolName: 'command.run',
                    argumentsJson: JSON.stringify({
                        command: 'pnpm',
                        args: ['exec', 'vitest', 'run', 'packages/core/src/tools/command-run.fixture.test.ts'],
                    }),
                },
                { kind: 'response_completed', content: 'patch and test complete' },
            ]),
        });

        // Then
        expect(output).toContain('Applied patch: .mctrl-task20.txt');
        expect(output).toContain('Command output for command.run');
        expect(output).toContain('stdout:\ntask20 ok');
        expect(await readFile(join(workspaceRoot, '.mctrl-task20.txt'), 'utf8')).toBe('approved\n');
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
        expect(await replayedTypes('session_task20_control')).toEqual(expect.arrayContaining(['run.interrupted']));
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

async function replayedMessages(sessionId: string): Promise<readonly string[]> {
    return replayedEvents(sessionId).then((events) =>
        events.map((event) => event.message).filter((message): message is string => message !== undefined),
    );
}

async function replayedTypes(sessionId: string): Promise<readonly string[]> {
    return replayedEvents(sessionId).then((events) => events.map((event) => event.type));
}

async function replayedEvents(sessionId: string): Promise<readonly AgentEvent[]> {
    const output = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
    return output
        .split(/\r?\n/)
        .filter((line) => line.trim().length > 0)
        .map(
            (line) =>
                AgentEventEnvelopeSchema.parse({
                    eventId: 'ignored',
                    sequence: 0,
                    createdAt: new Date(0).toISOString(),
                    sessionId,
                    durability: 'durable',
                    event: JSON.parse(line),
                }).event,
        );
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
