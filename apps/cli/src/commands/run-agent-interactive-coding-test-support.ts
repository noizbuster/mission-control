import type {
    CommandExecutionRequest,
    CommandExecutionResult,
    ProviderAdapter,
    ProviderTurnRequest,
} from '@mission-control/core';
import type { ProviderStreamChunk } from '@mission-control/protocol';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export function addFilePatch(path: string, content: string): string {
    return [
        `diff --git a/${path} b/${path}`,
        '--- /dev/null',
        `+++ b/${path}`,
        '@@ -0,0 +1 @@',
        `+${content}`,
        '',
    ].join('\n');
}

export async function fakeCommandExecutor(_request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'task20 ok\n',
        stderr: '',
        durationMs: 1,
    };
}

export async function writeFixtureFile(workspaceRoot: string, path: string, content: string): Promise<void> {
    await writeFile(join(workspaceRoot, path), content);
}

export function providerFromApprovedToolRequests(requests: ProviderTurnRequest[]): ProviderAdapter {
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

export function providerThatAdaptsAfterDenial(): ProviderAdapter {
    let calls = 0;
    return {
        async *streamTurn(request) {
            calls += 1;
            if (calls === 1) {
                yield {
                    kind: 'tool_call_completed',
                    requestId: request.requestId,
                    sequence: 1,
                    toolCall: {
                        toolCallId: 'patch_call',
                        toolName: 'file.patch',
                        argumentsJson: JSON.stringify({ patch: addFilePatch('.mctrl-task20.txt', 'denied') }),
                    },
                };
                yield cliCompletedChunk(request, 'patch proposed', ['patch_call']);
                return;
            }
            // The model sees the denial in tool-result history and adapts — text only, no retry.
            yield cliCompletedChunk(request, 'skipping the denied patch');
        },
    };
}

export function providerFromTurnRequests(requests: ProviderTurnRequest[]): ProviderAdapter {
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
