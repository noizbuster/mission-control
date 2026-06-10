import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createDeterministicProvider,
    missionControlDataDirEnvKey,
} from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support.js';
import { runSessionCommand } from './session.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
                    argumentsJson: JSON.stringify({ command: 'pnpm', args: ['typecheck'] }),
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
