import type {
    CommandExecutionRequest,
    CommandExecutionResult,
    ProviderAdapter,
    ProviderAdapterContext,
    ProviderTurnRequest,
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
import { replayedTypes } from './session-replay-test-support.js';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent interactive coding tool registry', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('advertises coding-agent aliases and executes ls plus read before approved file.patch', async () => {
        const dataDir = await tempRoot('mctrl-tools-data-');
        const workspaceRoot = await tempRoot('mctrl-tools-workspace-');
        await mkdir(join(workspaceRoot, 'src'));
        await writeFile(join(workspaceRoot, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();
        const requests: ProviderTurnRequest[] = [];
        const events: AgentEvent[] = [];

        const output = await runAgent(parseArgs(['--session', 'session_task4_tools']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput(
                [
                    { type: 'line', value: 'inspect workspace then patch' },
                    { type: 'line', value: 'y' },
                    { type: 'interrupt' },
                    { type: 'interrupt' },
                ],
                50,
            ),
            chatOutput: chatOutput.output,
            workspaceRoot,
            commandExecutor: fakeCommandExecutor,
            provider: providerFromTurns(requests, [
                [
                    {
                        kind: 'tool_call_completed',
                        toolCallId: 'list_call',
                        toolName: 'ls',
                        argumentsJson: JSON.stringify({ path: '.' }),
                    },
                    {
                        kind: 'tool_call_completed',
                        toolCallId: 'read_call',
                        toolName: 'read',
                        argumentsJson: JSON.stringify({ path: 'src/index.ts' }),
                    },
                    { kind: 'response_completed', content: 'inspected workspace' },
                ],
                [
                    {
                        kind: 'tool_call_completed',
                        toolCallId: 'patch_call',
                        toolName: 'file.patch',
                        argumentsJson: JSON.stringify({ patch: addFilePatch('.mctrl-task4.txt', 'approved') }),
                    },
                    { kind: 'response_completed', content: 'patch requested' },
                ],
                [{ kind: 'response_completed', content: 'listed and patched' }],
            ]),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual([
            'read',
            'ls',
            'grep',
            'find',
            'glob',
            'todowrite',
            'skill',
            'webfetch',
            'file.edit',
            'file.write',
            'file.patch',
            'command.run',
            'task',
        ]);
        expect(output).not.toContain('Approve ls?');
        expect(output).not.toContain('Approve read?');
        expect(output).toContain('Approve file.patch? [once/always/deny]:');
        expect(output).toContain('Applied patch: .mctrl-task4.txt');
        expect(await readFile(join(workspaceRoot, '.mctrl-task4.txt'), 'utf8')).toBe('approved\n');
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'tool.completed',
                taskId: 'read_call',
            }),
        );
        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['tool.completed', 'file.diff.applied']),
        );
        expect(await replayedTypes('session_task4_tools')).toEqual(
            expect.arrayContaining(['tool.completed', 'file.diff.applied']),
        );
    });

    it('denies read of reference repos without an approval prompt', async () => {
        const dataDir = await tempRoot('mctrl-tools-data-');
        const workspaceRoot = await tempRoot('mctrl-tools-workspace-');
        await mkdir(join(workspaceRoot, 'temp', 'ref-repos', 'opencode'), { recursive: true });
        await writeFile(join(workspaceRoot, 'temp', 'ref-repos', 'opencode', 'README.md'), 'hidden', 'utf8');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs(['--session', 'session_task4_deny_read']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'read reference repo' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            provider: providerFromTurns(
                [],
                [
                    [
                        {
                            kind: 'tool_call_completed',
                            toolCallId: 'read_denied',
                            toolName: 'read',
                            argumentsJson: JSON.stringify({ path: 'temp/ref-repos/opencode/README.md' }),
                        },
                        { kind: 'response_completed', content: 'read denied by registry' },
                    ],
                    [{ kind: 'response_completed', content: 'read denied' }],
                ],
            ),
        });

        expect(output).not.toContain('Approve read?');
        expect(output).toContain('read failed: workspace_denied');
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

type ProviderStep =
    | {
          readonly kind: 'tool_call_completed';
          readonly toolCallId: string;
          readonly toolName: string;
          readonly argumentsJson: string;
      }
    | {
          readonly kind: 'response_completed';
          readonly content: string;
      };

function providerFromTurns(
    requests: ProviderTurnRequest[],
    turns: readonly (readonly ProviderStep[])[],
): ProviderAdapter {
    return {
        async *streamTurn(request: ProviderTurnRequest, _context: ProviderAdapterContext) {
            requests.push(request);
            const steps = turns[requests.length - 1] ?? [{ kind: 'response_completed', content: 'done' }];
            for (const [index, step] of steps.entries()) {
                yield chunkForStep(request, step, index + 1);
            }
        },
    };
}

function chunkForStep(request: ProviderTurnRequest, step: ProviderStep, sequence: number): ProviderStreamChunk {
    if (step.kind === 'tool_call_completed') {
        return {
            kind: 'tool_call_completed',
            requestId: request.requestId,
            sequence,
            toolCall: {
                toolCallId: step.toolCallId,
                toolName: step.toolName,
                argumentsJson: step.argumentsJson,
            },
        };
    }
    return {
        kind: 'response_completed',
        requestId: request.requestId,
        sequence,
        message: {
            messageId: `message_${request.turnId}`,
            role: 'assistant',
            content: step.content,
        },
        finishReason: 'stop',
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

async function fakeCommandExecutor(_request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'task4 ok\n',
        stderr: '',
        durationMs: 1,
    };
}
