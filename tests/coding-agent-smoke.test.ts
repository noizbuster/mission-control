import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    missionControlDataDirEnvKey,
    type ProviderAdapter,
    type ProviderTurnRequest,
    projectJsonlSessionReplayPrefix,
} from '@mission-control/core';
import { type AgentEvent, AgentEventSchema, type ProviderStreamChunk } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../apps/cli/src/args.js';
import { runAgent } from '../apps/cli/src/commands/run-agent.js';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from '../apps/cli/src/commands/run-agent-chat-test-support.js';
import { runSessionCommand } from '../apps/cli/src/commands/session.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('coding-agent end-to-end smoke', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('replays deterministic chat patch command and graph JSONL output from one temp workspace', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-smoke-data-');
        const workspaceRoot = await tempRoot('mctrl-smoke-workspace-');
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);
        const chatSessionId = 'session_smoke_coding_agent';
        const graphSessionId = 'session_smoke_graph';
        const chatOutput = createBufferedChatOutput();

        // When
        const chat = await runAgent(parseArgs(['--session', chatSessionId, '--model', 'local/local-echo']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'make an approved smoke patch and run typecheck' },
                { type: 'line', value: 'y' },
                { type: 'line', value: 'y' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            commandExecutor: fakeTypecheckExecutor,
            provider: providerFromTurns([
                [
                    { kind: 'text_delta', delta: 'Preparing smoke patch.' },
                    {
                        kind: 'tool_call_completed',
                        toolCallId: 'smoke_patch',
                        toolName: 'file.patch',
                        argumentsJson: JSON.stringify({
                            patch: addFilePatch('.mission-control-smoke.txt', 'smoke complete'),
                        }),
                    },
                    { kind: 'response_completed', content: 'patch requested' },
                ],
                [
                    {
                        kind: 'tool_call_completed',
                        toolCallId: 'smoke_typecheck',
                        toolName: 'command.run',
                        argumentsJson: JSON.stringify({ command: 'pnpm', args: ['typecheck'] }),
                    },
                    { kind: 'response_completed', content: 'typecheck requested' },
                ],
                [{ kind: 'response_completed', content: 'smoke complete' }],
            ]),
        });
        const replayedChatEvents = parseEventLines(
            await runSessionCommand(parseArgs(['session', 'replay', chatSessionId, '--jsonl'])),
        );
        const graphJsonl = await runAgent(
            parseArgs([
                'graph',
                'run',
                'examples/abg/coding-agent.graph.json',
                '--session',
                graphSessionId,
                '--jsonl',
                '--model',
                'local/local-echo',
            ]),
        );
        const graphEvents = parseEventLines(graphJsonl);
        const graphReplay = projectJsonlSessionReplayPrefix({
            sessionId: graphSessionId,
            contents: await readFile(join(dataDir, 'sessions', `${graphSessionId}.jsonl`), 'utf8'),
        }).projection;

        // Then
        expect(chat).toContain('Patch preview for file.patch');
        expect(chat).toContain('Applied patch: .mission-control-smoke.txt');
        expect(chat).toContain('Command output for command.run');
        expect(chat).toContain('stdout:\ntypecheck ok');
        await expect(readFile(join(workspaceRoot, '.mission-control-smoke.txt'), 'utf8')).resolves.toBe(
            'smoke complete\n',
        );
        expect(replayedChatEvents.map((event) => event.type)).toEqual(
            expect.arrayContaining([
                'task.started',
                'run.started',
                'approval.requested',
                'approval.updated',
                'file.diff.applied',
                'command.completed',
                'model.call.completed',
                'tool.completed',
            ]),
        );
        expect(replayedChatEvents.filter((event) => event.type === 'approval.requested')).toHaveLength(2);
        expect(replayedChatEvents.filter((event) => event.type === 'approval.updated')).toHaveLength(2);
        expect(commandCompleted(replayedChatEvents)?.command).toMatchObject({
            command: ['pnpm', 'typecheck'],
            status: 'completed',
            exitCode: 0,
        });
        expect(graphEvents.map((event) => event.type)).toEqual(
            expect.arrayContaining(['graph.started', 'approval.requested', 'policy.blocked', 'graph.failed']),
        );
        expect(graphReplay.graphSnapshots).toEqual(
            expect.arrayContaining([
                expect.objectContaining({
                    graphId: 'coding-agent',
                    status: 'blocked',
                }),
            ]),
        );
        expect(graphJsonl).not.toContain('OPENAI_API_KEY');
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

function parseEventLines(output: string): readonly AgentEvent[] {
    return output
        .trim()
        .split(/\r?\n/)
        .filter((line) => line.length > 0)
        .map((line) => AgentEventSchema.parse(JSON.parse(line)));
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

type ProviderStep =
    | {
          readonly kind: 'text_delta';
          readonly delta: string;
      }
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

function providerFromTurns(turns: readonly (readonly ProviderStep[])[]): ProviderAdapter {
    const requests: ProviderTurnRequest[] = [];
    return {
        async *streamTurn(request) {
            requests.push(request);
            const steps = turns[requests.length - 1] ?? [{ kind: 'response_completed', content: 'done' }];
            for (const [index, step] of steps.entries()) {
                yield chunkForStep(request, step, index + 1);
            }
        },
    };
}

function chunkForStep(request: ProviderTurnRequest, step: ProviderStep, sequence: number): ProviderStreamChunk {
    if (step.kind === 'text_delta') {
        return { kind: 'text_delta', requestId: request.requestId, sequence, delta: step.delta };
    }
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

async function fakeTypecheckExecutor(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    expect([request.command, ...request.args]).toEqual(['pnpm', 'typecheck']);
    return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'typecheck ok\n',
        stderr: '',
        durationMs: 1,
    };
}

function commandCompleted(events: readonly AgentEvent[]): AgentEvent | undefined {
    return events.find((event) => event.type === 'command.completed');
}
