import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createDeterministicProvider,
    missionControlDataDirEnvKey,
    type ProviderAdapter,
    ProviderTurnError,
    readLocalSessionReplay,
} from '@mission-control/core';
import type { ProviderStreamChunk } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { runAgent } from './run-agent';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support';
import { providerFromTurns } from './run-agent-tool-registry-test-support';
import { runSessionCommand } from './session';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const allowedHarnessArgs = ['--eval', "console.log('mission-control command.run harness ok')"] as const;

describe('interactive coding-agent redaction', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('redacts token-like provider and command output in CLI output and replay JSONL', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-redaction-data-');
        const workspaceRoot = await tempRoot('mctrl-redaction-workspace-');
        const sessionId = 'session_cli_redaction';
        const secret = ['sk', 'cli_redaction_123'].join('-');
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);

        // When
        const output = await runAgent(parseArgs(['--session', sessionId]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'redact command and provider output' },
                { type: 'line', value: 'y' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: createBufferedChatOutput().output,
            workspaceRoot,
            commandExecutor: fakeSecretCommandExecutor(secret),
            plainPromptGraph: 'coding-agent',
            provider: createDeterministicProvider([
                { kind: 'text_delta', delta: `stream ${secret}` },
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'command_secret',
                    toolName: 'command.run',
                    argumentsJson: JSON.stringify({ command: 'node', args: allowedHarnessArgs }),
                },
                { kind: 'response_completed', content: `final ${secret}` },
            ]),
        });
        const replay = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));

        // Then
        expect(output).toContain('[REDACTED_CREDENTIAL]');
        expect(output).not.toContain(secret);
        expect(replay.stdout).toContain('[REDACTED_CREDENTIAL]');
        expect(replay.stdout).not.toContain(secret);
    });

    // Exercises the graph path: it asserts the pre-approval tool-arg PREVIEW is rendered and redacted
    // (Gap A landed the graph preview rendering) AND the deny model terminates the run. The graph
    // engine is now the only engine (flat removed); denial is terminal, not resumable.
    it('redacts provider-supplied tool argument previews before approval', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-preview-redaction-data-');
        const workspaceRoot = await tempRoot('mctrl-preview-redaction-workspace-');
        const secret = ['sk', 'tool_preview_123'].join('-');
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);

        // When
        const commandPreview = await runAgent(
            parseArgs(['--session', 'session_cli_command_preview_redaction', '--engine', 'graph']),
            {
                authStore: createEmptyAuthStore(),
                chatInput: createScriptedChatInput([
                    { type: 'line', value: 'preview command tool arguments' },
                    { type: 'line', value: 'n' },
                    { type: 'interrupt' },
                    { type: 'interrupt' },
                ]),
                chatOutput: createBufferedChatOutput().output,
                workspaceRoot,
                commandExecutor: fakeSecretCommandExecutor(secret),
                plainPromptGraph: 'coding-agent',
                provider: providerFromTurns(
                    [],
                    [
                        [
                            {
                                kind: 'tool_call_completed',
                                toolCallId: 'command_preview_secret',
                                toolName: 'command.run',
                                argumentsJson: JSON.stringify({
                                    command: 'pnpm',
                                    args: ['exec', 'vitest', 'run', `${secret}.test.ts`],
                                }),
                            },
                            { kind: 'response_completed', content: 'preview command' },
                        ],
                        [{ kind: 'response_completed', content: 'adapted after command denial' }],
                    ],
                ),
            },
        );
        const patchPreview = await runAgent(
            parseArgs(['--session', 'session_cli_patch_preview_redaction', '--engine', 'graph']),
            {
                authStore: createEmptyAuthStore(),
                chatInput: createScriptedChatInput([
                    { type: 'line', value: 'preview patch tool arguments' },
                    { type: 'line', value: 'n' },
                    { type: 'interrupt' },
                    { type: 'interrupt' },
                ]),
                chatOutput: createBufferedChatOutput().output,
                workspaceRoot,
                plainPromptGraph: 'coding-agent',
                provider: providerFromTurns(
                    [],
                    [
                        [
                            {
                                kind: 'tool_call_completed',
                                toolCallId: 'patch_preview_secret',
                                toolName: 'file.patch',
                                argumentsJson: JSON.stringify({ patch: addFilePatch('.preview-secret.txt', secret) }),
                            },
                            { kind: 'response_completed', content: 'preview patch' },
                        ],
                        [{ kind: 'response_completed', content: 'adapted after patch denial' }],
                    ],
                ),
            },
        );

        // Then
        const previewOutput = `${commandPreview}\n${patchPreview}`;
        expect(previewOutput).toContain('[REDACTED_CREDENTIAL]');
        expect(previewOutput).not.toContain(secret);
        expect(commandPreview).toContain('Command preview for command.run');
        expect(patchPreview).toContain('Patch preview for file.patch');
    });

    it('redacts raw provider failures in CLI errors persisted replay and replay JSONL', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-redaction-failure-data-');
        const workspaceRoot = await tempRoot('mctrl-redaction-failure-workspace-');
        const sessionId = 'session_cli_redaction_failure';
        const secret = ['sk', 'cli_failure_123'].join('-');
        const chatOutput = createBufferedChatOutput();
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);

        // When
        await runAgent(parseArgs(['--session', sessionId]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([{ type: 'line', value: 'trigger provider failure' }]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            provider: throwingProvider(`provider exploded ${secret}`),
        });
        const replay = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
        const storedReplay = await readStoredReplay(dataDir, sessionId);

        // Then
        const chat = chatOutput.getOutput();
        expect(chat).toContain('Error:');
        expect(storedReplay.projection.envelopes.some((envelope) => envelope.event.type === 'task.failed')).toBe(true);
        expect(JSON.stringify({ chat, replay, storedReplay })).toContain('[REDACTED_CREDENTIAL]');
        expect(JSON.stringify({ chat, replay, storedReplay })).not.toContain(secret);
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

async function readStoredReplay(dataDir: string, sessionId: string) {
    const result = await readLocalSessionReplay({ dataDir, sessionId });
    if (result.kind !== 'found') {
        throw new Error(`expected replay for ${sessionId}`);
    }
    return result.replay;
}

function fakeSecretCommandExecutor(
    secret: string,
): (request: CommandExecutionRequest) => Promise<CommandExecutionResult> {
    return async () => ({
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: `stdout ${secret}\n`,
        stderr: `stderr ${secret}\n`,
        durationMs: 1,
    });
}

function throwingProvider(message: string): ProviderAdapter {
    return {
        streamTurn() {
            return rejectingProviderStream(message);
        },
    };
}

function rejectingProviderStream(message: string): AsyncIterable<ProviderStreamChunk> {
    return {
        [Symbol.asyncIterator]() {
            return {
                next(): Promise<IteratorResult<ProviderStreamChunk>> {
                    return Promise.reject(
                        new ProviderTurnError({
                            code: 'provider_auth_failed',
                            message,
                            retryable: false,
                        }),
                    );
                },
            };
        },
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
