import { createDeterministicProvider } from '@mission-control/core';
import { AgentEventSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent JSON blocked lifecycle', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('reports approval-blocked runs without task.failed in JSONL output', async () => {
        const dataDir = await tempRoot('mctrl-json-blocked-data-');
        const workspaceRoot = await tempRoot('mctrl-json-blocked-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);

        const output = await runAgent(
            parseArgs(['run', 'apply a blocked patch', '--jsonl', '--session', 'session_json_blocked']),
            {
                workspaceRoot,
                provider: createDeterministicProvider([
                    {
                        kind: 'tool_call_completed',
                        toolCallId: 'blocked_patch_call',
                        toolName: 'file.patch',
                        argumentsJson: JSON.stringify({
                            patch: addFilePatch('.blocked.txt', 'blocked'),
                        }),
                    },
                    { kind: 'response_completed', content: 'approval required' },
                ]),
            },
        );
        const events = parseJsonEvents(output);

        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['approval.requested', 'approval.blocked', 'run.blocked']),
        );
        expect(events.some((event) => event.type === 'task.failed')).toBe(false);
        expect(events.some((event) => event.type === 'task.completed')).toBe(false);
        expect(events.find((event) => event.type === 'run.blocked')?.run).toMatchObject({
            state: 'blocked_on_approval',
            toolCallId: 'blocked_patch_call',
        });

        const records = parseJsonRecords(output);
        const finalRecord = lastRecord(records);
        expect(finalRecord).toMatchObject({
            type: 'session.stopped',
            sessionId: 'session_json_blocked',
            status: 'blocked_on_approval',
            runId: expect.stringMatching(/^run_.+/),
            toolCallId: 'blocked_patch_call',
            approvalId: expect.stringMatching(/^approval_.+/),
            machine: {
                run: {
                    runId: expect.stringMatching(/^run_.+/),
                    status: 'blocked_on_approval',
                    toolCallId: 'blocked_patch_call',
                },
                approval: {
                    approvalId: expect.stringMatching(/^approval_.+/),
                    state: 'pending',
                    toolCallId: 'blocked_patch_call',
                    resumable: true,
                },
            },
        });
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

function parseJsonEvents(output: string) {
    return output
        .trim()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => AgentEventSchema.parse(JSON.parse(line)));
}

function parseJsonRecords(output: string): readonly Record<string, unknown>[] {
    return output
        .trim()
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

function lastRecord(records: readonly Record<string, unknown>[]): Record<string, unknown> {
    const record = records.at(-1);
    if (record === undefined) {
        throw new Error('expected at least one JSON record');
    }
    return record;
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
