import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createDeterministicProvider,
    missionControlDataDirEnvKey,
    type ProviderAdapter,
} from '@mission-control/core';
import type { ProviderStreamChunk } from '@mission-control/protocol';
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
        expect(replay).toContain('[REDACTED_CREDENTIAL]');
        expect(replay).not.toContain(secret);
    });

    it('redacts provider-supplied tool argument previews before approval', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-preview-redaction-data-');
        const workspaceRoot = await tempRoot('mctrl-preview-redaction-workspace-');
        const secret = ['sk', 'tool_preview_123'].join('-');
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);

        // When
        const commandPreview = await runAgent(parseArgs(['--session', 'session_cli_command_preview_redaction']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'preview command tool arguments' },
                { type: 'line', value: 'n' },
                { type: 'interrupt' },
            ]),
            chatOutput: createBufferedChatOutput().output,
            workspaceRoot,
            commandExecutor: fakeSecretCommandExecutor(secret),
            provider: createDeterministicProvider([
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
            ]),
        });
        const patchPreview = await runAgent(parseArgs(['--session', 'session_cli_patch_preview_redaction']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'preview patch tool arguments' },
                { type: 'line', value: 'n' },
                { type: 'interrupt' },
            ]),
            chatOutput: createBufferedChatOutput().output,
            workspaceRoot,
            provider: createDeterministicProvider([
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'patch_preview_secret',
                    toolName: 'file.patch',
                    argumentsJson: JSON.stringify({ patch: addFilePatch('.preview-secret.txt', secret) }),
                },
                { kind: 'response_completed', content: 'preview patch' },
            ]),
        });

        // Then
        const previewOutput = `${commandPreview}\n${patchPreview}`;
        expect(previewOutput).toContain('[REDACTED_CREDENTIAL]');
        expect(previewOutput).not.toContain(secret);
    });

    it('redacts raw provider failures in CLI errors persisted JSONL and replay JSONL', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-redaction-failure-data-');
        const workspaceRoot = await tempRoot('mctrl-redaction-failure-workspace-');
        const sessionId = 'session_cli_redaction_failure';
        const secret = ['sk', 'cli_failure_123'].join('-');
        const chatOutput = createBufferedChatOutput();
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);

        // When
        const errorMessage = await rejectedMessage(() =>
            runAgent(parseArgs(['--session', sessionId]), {
                authStore: createEmptyAuthStore(),
                chatInput: createScriptedChatInput([{ type: 'line', value: 'trigger provider failure' }]),
                chatOutput: chatOutput.output,
                workspaceRoot,
                provider: throwingProvider(`provider exploded ${secret}`),
            }),
        );
        const replay = await runSessionCommand(parseArgs(['session', 'replay', sessionId, '--jsonl']));
        const sessionLog = await readFile(join(dataDir, 'sessions', `${sessionId}.jsonl`), 'utf8');

        // Then
        expect(JSON.stringify({ chat: chatOutput.getOutput(), errorMessage, replay, sessionLog })).toContain(
            '[REDACTED_CREDENTIAL]',
        );
        expect(JSON.stringify({ chat: chatOutput.getOutput(), errorMessage, replay, sessionLog })).not.toContain(
            secret,
        );
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

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
                    return Promise.reject(new Error(message));
                },
            };
        },
    };
}

async function rejectedMessage(run: () => Promise<string>): Promise<string> {
    try {
        await run();
    } catch (error: unknown) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error('expected runAgent to reject');
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
