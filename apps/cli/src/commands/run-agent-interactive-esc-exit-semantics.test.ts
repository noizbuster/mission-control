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

describe('runAgent interactive ESC vs Ctrl+C exit semantics', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('ESC-sourced interrupts never exit the chat loop, even on rapid double-press', async () => {
        const dataDir = await tempRoot('mctrl-esc-exit-data-');
        const workspaceRoot = await tempRoot('mctrl-esc-exit-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs(['--session', 'session_esc_no_exit']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'interrupt', source: 'esc' },
                { type: 'interrupt', source: 'esc' },
                { type: 'interrupt', source: 'esc' },
                { type: 'line', value: '/exit' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            provider: createDeterministicProvider([{ kind: 'response_completed', content: 'ok' }]),
        });

        // The loop must still be alive to process /exit (the last scripted
        // event). If ESC had exited, runAgent would return early without
        // ever consuming /exit, and the output would lack the exit banner.
        expect(output).toContain('Exiting mission-control chat');
        expect(output).not.toContain('Press Ctrl+C again to exit');
    });

    it('Ctrl+C-sourced interrupts still exit on second consecutive press when idle', async () => {
        const dataDir = await tempRoot('mctrl-ctrlc-exit-data-');
        const workspaceRoot = await tempRoot('mctrl-ctrlc-exit-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs(['--session', 'session_ctrlc_exit']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'interrupt', source: 'ctrl-c' },
                { type: 'interrupt', source: 'ctrl-c' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            provider: createDeterministicProvider([{ kind: 'response_completed', content: 'ok' }]),
        });

        expect(output).toContain('Press Ctrl+C again to exit');
    });

    it('ESC interrupt stops an active run without exiting (run still accepts /exit afterward)', async () => {
        const dataDir = await tempRoot('mctrl-esc-stop-data-');
        const workspaceRoot = await tempRoot('mctrl-esc-stop-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();
        const events: AgentEvent[] = [];

        const output = await runAgent(parseArgs(['--session', 'session_esc_stop_active']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'run a command that should be interrupted' },
                { type: 'line', value: 'y' },
                { type: 'interrupt', source: 'esc' },
                { type: 'line', value: '/exit' },
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
                        args: ['--eval', "console.log('esc interrupt harness ok')"],
                    }),
                },
                { kind: 'response_completed', content: 'command started' },
            ]),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
        });

        expect(output).toContain('Interrupted active run');
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'run.interrupted',
            }),
        );
        expect(output).toContain('Exiting mission-control chat');
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
        const timeout = setTimeout(() => resolve(completedResult()), 30_000);
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
        timedOut: false,
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
