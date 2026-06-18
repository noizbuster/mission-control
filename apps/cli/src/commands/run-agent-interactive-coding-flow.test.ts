import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    type ProviderAdapter,
    type ProviderTurnRequest,
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
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent interactive coding agent flow', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('continues with patch and command tool results before rendering the final summary', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-task17-data-');
        const workspaceRoot = await tempRoot('mctrl-task17-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const requests: ProviderTurnRequest[] = [];
        const chatOutput = createBufferedChatOutput();

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task17_happy']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'patch a file and run qa' },
                { type: 'line', value: 'y' },
                { type: 'line', value: 'y' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            commandExecutor: task17CommandExecutor,
            provider: providerFromTask17Requests(requests),
        });

        // Then
        expect(output).toContain('Applied patch: .mctrl-task17.txt');
        expect(output).toContain('Command output for command.run');
        expect(output).toContain('stdout:\ntask17 ok');
        expect(output).toContain('Assistant: patch and command complete');
        expect(await readFile(join(workspaceRoot, '.mctrl-task17.txt'), 'utf8')).toBe('approved\n');
    });

    it('prints a blocked denied status when patch approval is denied', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-task17-deny-data-');
        const workspaceRoot = await tempRoot('mctrl-task17-deny-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const events: AgentEvent[] = [];
        const chatOutput = createBufferedChatOutput();

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task17_deny']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'patch a file without approval' },
                { type: 'line', value: 'n' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            provider: providerWithDeniedPatch(),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        // Then — on the graph a denial is terminal (the tool settles `approval_denied` and the run
        // fails), matching the graph's documented deny semantics; the flat escape hatch keeps its
        // resumable-block behavior.
        expect(output).toContain('Denied file.patch');
        expect(output).toContain('file.patch failed: approval_denied');
        expect(output).toContain('Error: ABG run failed on a non-retryable tool settlement');
        expect(events.some((event) => event.type === 'task.failed')).toBe(true);
        expect(events.some((event) => event.type === 'run.blocked')).toBe(false);
        await expect(readFile(join(workspaceRoot, '.mctrl-task17-denied.txt'), 'utf8')).rejects.toThrow();
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

async function task17CommandExecutor(_request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'task17 ok\n',
        stderr: '',
        durationMs: 1,
    };
}

function providerFromTask17Requests(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            if (requests.length === 1) {
                yield task17ToolCall(request, 'patch_call_task17', 'file.patch', {
                    patch: addFilePatch('.mctrl-task17.txt', 'approved'),
                });
                yield task17ToolCall(request, 'command_call_task17', 'command.run', {
                    command: 'node',
                    args: ['--eval', "console.log('mission-control command.run harness ok')"],
                });
                yield completedChunk(request, 'tools requested', ['patch_call_task17', 'command_call_task17']);
                return;
            }
            yield completedChunk(request, 'patch and command complete');
        },
    };
}

function providerWithDeniedPatch(): ProviderAdapter {
    return {
        async *streamTurn(request) {
            yield task17ToolCall(request, 'patch_call_task17_denied', 'file.patch', {
                patch: addFilePatch('.mctrl-task17-denied.txt', 'denied'),
            });
            yield completedChunk(request, 'patch proposed', ['patch_call_task17_denied']);
        },
    };
}

function task17ToolCall(
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
