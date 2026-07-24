import { createDeterministicProvider } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { captureSequentialProvider } from './compact-command-test-support';
import { runAgent } from './run-agent';
import { writeToolWorkflow } from './run-agent-json-approval-test-support';
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
    const workflowName = 'json-headless-tools';

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    it('emits a completed final state for no-session JSON prompts', async () => {
        const dataDir = await tempRoot('mctrl-json-headless-completed-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);

        const output = await runAgent(parseArgs(['run', 'summarize this repository', '--json']), {
            provider: captureSequentialProvider([], ['exploratory-research', 'true', 'summarized']),
        });
        const finalRecord = lastRecord(parseJsonRecords(output));

        expect(finalRecord).toMatchObject({
            type: 'session.stopped',
            status: 'completed',
            runId: expect.stringMatching(/^run_.+/),
            machine: {
                run: {
                    runId: expect.stringMatching(/^run_.+/),
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
            runId: expect.stringMatching(/^run_.+/),
        });
    });

    it('emits a failed final state for a remote provider abort after bounded retries', async () => {
        const dataDir = await tempRoot('mctrl-json-headless-remote-abort-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);

        const output = await runAgent(parseArgs(['run', 'remote provider abort', '--json']), {
            provider: createDeterministicProvider([
                {
                    kind: 'response_failed',
                    error: {
                        code: 'provider_aborted',
                        message: 'provider aborted',
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
            runId: expect.stringMatching(/^run_.+/),
        });
    });

    it('emits blocked_on_approval with ids when headless command.run needs approval', async () => {
        const dataDir = await tempRoot('mctrl-json-headless-command-blocked-data-');
        const workspaceRoot = await tempRoot('mctrl-json-headless-command-blocked-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await writeToolWorkflow(workspaceRoot, workflowName);
        let commandCalls = 0;

        const output = await runAgent(parseArgs(['run', `#${workflowName} try a headless command`, '--json']), {
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
                        args: ['--eval', "console.log('mission-control command.run approval required')"],
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
            runId: expect.stringMatching(/^run_.+/),
            toolCallId: 'json_command_pending_call',
            approvalId: expect.stringMatching(/^approval_.+/),
        });
    });

    it('emits blocked_on_approval when headless command.run is not auto-approved', async () => {
        const dataDir = await tempRoot('mctrl-json-headless-command-data-');
        const workspaceRoot = await tempRoot('mctrl-json-headless-command-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await writeToolWorkflow(workspaceRoot, workflowName);
        let commandCalls = 0;

        const output = await runAgent(parseArgs(['run', `#${workflowName} try another headless command`, '--json']), {
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
            status: 'blocked_on_approval',
            runId: expect.stringMatching(/^run_.+/),
            toolCallId: 'json_command_call',
            approvalId: expect.stringMatching(/^approval_.+/),
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
    for (let i = records.length - 1; i >= 0; i -= 1) {
        const candidate = records[i];
        if (candidate !== undefined && candidate.type !== 'session.finalize') {
            return candidate;
        }
    }
    throw new Error('expected at least one JSON record');
}
