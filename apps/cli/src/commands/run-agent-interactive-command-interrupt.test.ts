import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    createDeterministicProvider,
} from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent interactive command interruption', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('interrupts an approved running command tool', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-chat-data-');
        const workspaceRoot = await tempRoot('mctrl-chat-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        // When
        const output = await runAgent(parseArgs(['--session', 'session_task20_command_interrupt']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'run a command that should be interrupted' },
                { type: 'line', value: 'y' },
                { type: 'line', value: '/interrupt' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            commandExecutor: interruptibleCommandExecutor,
            provider: createDeterministicProvider([
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'command_call',
                    toolName: 'command.run',
                    argumentsJson: JSON.stringify({
                        command: 'node',
                        args: ['--eval', "console.log('mission-control command.run harness ok')"],
                    }),
                },
                { kind: 'response_completed', content: 'command started' },
            ]),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        // Then
        expect(output).toContain('Approve command.run? [y/N]:');
        expect(output).toContain('command.run failed: command_failed');
        expect(output).toContain('Interrupted active run');
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'run.interrupted',
            }),
        );
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

function interruptibleCommandExecutor(request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    if (request.signal.aborted) {
        return Promise.resolve(interruptedResult());
    }
    return new Promise<CommandExecutionResult>((resolve) => {
        const timeout = setTimeout(() => resolve(completedResult()), 20);
        request.signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timeout);
                resolve(interruptedResult());
            },
            { once: true },
        );
    });
}

function interruptedResult(): CommandExecutionResult {
    return {
        exitCode: null,
        signal: 'SIGTERM',
        timedOut: true,
        stdout: 'partial command output\n',
        stderr: '',
        durationMs: 1,
    };
}

function completedResult(): CommandExecutionResult {
    return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        stdout: 'command completed before interrupt\n',
        stderr: '',
        durationMs: 20,
    };
}
