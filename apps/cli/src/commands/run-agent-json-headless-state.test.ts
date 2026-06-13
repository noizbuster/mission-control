import { createDeterministicProvider } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type JsonOutputRecord = Record<string, unknown> & {
    readonly type?: string;
    readonly status?: string;
    readonly runId?: string;
    readonly toolCallId?: string;
    readonly approvalId?: string;
};

describe('runAgent JSON headless final state', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    it('emits a completed final state for no-session JSON prompts', async () => {
        const dataDir = await tempRoot('mctrl-json-headless-completed-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);

        const output = await runAgent(parseArgs(['run', 'summarize this repository', '--json']));
        const finalRecord = lastRecord(parseJsonRecords(output));

        expect(finalRecord).toMatchObject({
            type: 'session.stopped',
            status: 'completed',
            runId: expect.any(String),
            machine: {
                run: {
                    runId: expect.any(String),
                    status: 'completed',
                },
            },
        });
    });

    it('emits a failed final state for no-session JSON provider failures', async () => {
        const dataDir = await tempRoot('mctrl-json-headless-failed-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);

        const output = await runAgent(parseArgs(['run', 'fail provider', '--json']), {
            provider: createDeterministicProvider([
                {
                    kind: 'response_failed',
                    error: {
                        code: 'unknown',
                        message: 'provider exploded',
                        retryable: false,
                    },
                },
            ]),
        });
        const records = parseJsonRecords(output);

        expect(records.map((record) => record.type)).toContain('run.failed');
        expect(lastRecord(records)).toMatchObject({
            type: 'session.stopped',
            status: 'failed',
            runId: expect.any(String),
        });
    });

    it('emits an interrupted final state for no-session JSON provider aborts', async () => {
        const dataDir = await tempRoot('mctrl-json-headless-interrupted-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);

        const output = await runAgent(parseArgs(['run', 'interrupt provider', '--json']), {
            provider: createDeterministicProvider([
                {
                    kind: 'response_failed',
                    error: {
                        code: 'provider_aborted',
                        message: 'provider aborted',
                        retryable: true,
                    },
                },
            ]),
        });
        const records = parseJsonRecords(output);

        expect(records.map((record) => record.type)).toContain('run.interrupted');
        expect(lastRecord(records)).toMatchObject({
            type: 'session.stopped',
            status: 'interrupted',
            runId: expect.any(String),
        });
    });

    it('emits blocked_on_approval with ids when headless command.run needs approval', async () => {
        const dataDir = await tempRoot('mctrl-json-headless-command-blocked-data-');
        const workspaceRoot = await tempRoot('mctrl-json-headless-command-blocked-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        let commandCalls = 0;

        const output = await runAgent(parseArgs(['run', 'try a trusted headless command', '--json']), {
            workspaceRoot,
            commandExecutor: async () => {
                commandCalls += 1;
                throw new Error('command executor must not run while approval is pending');
            },
            provider: createDeterministicProvider([
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'json_command_pending_call',
                    toolName: 'command.run',
                    argumentsJson: JSON.stringify({
                        command: 'node',
                        args: ['--eval', "console.log('mission-control command.run harness ok')"],
                    }),
                },
                { kind: 'response_completed', content: 'should not complete task' },
            ]),
        });
        const finalRecord = lastRecord(parseJsonRecords(output));

        expect(commandCalls).toBe(0);
        expect(finalRecord).toMatchObject({
            type: 'session.stopped',
            status: 'blocked_on_approval',
            runId: expect.any(String),
            toolCallId: 'json_command_pending_call',
            approvalId: expect.any(String),
        });
    });

    it('emits failed when headless command.run is denied before execution', async () => {
        const dataDir = await tempRoot('mctrl-json-headless-command-data-');
        const workspaceRoot = await tempRoot('mctrl-json-headless-command-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        let commandCalls = 0;

        const output = await runAgent(parseArgs(['run', 'try a headless command', '--json']), {
            workspaceRoot,
            commandExecutor: async () => {
                commandCalls += 1;
                throw new Error('command executor must not run when approval is required');
            },
            provider: createDeterministicProvider([
                {
                    kind: 'tool_call_completed',
                    toolCallId: 'json_command_call',
                    toolName: 'command.run',
                    argumentsJson: JSON.stringify({ command: 'pnpm', args: ['test'] }),
                },
                { kind: 'response_completed', content: 'should not complete task' },
            ]),
        });
        const finalRecord = lastRecord(parseJsonRecords(output));

        expect(commandCalls).toBe(0);
        expect(finalRecord).toMatchObject({
            type: 'session.stopped',
            status: 'failed',
            runId: expect.any(String),
            toolCallId: 'json_command_call',
        });
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

function parseJsonRecords(output: string): readonly JsonOutputRecord[] {
    return output
        .trim()
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as JsonOutputRecord);
}

function lastRecord(records: readonly JsonOutputRecord[]): JsonOutputRecord {
    const record = records.at(-1);
    if (record === undefined) {
        throw new Error('expected at least one JSON record');
    }
    return record;
}
