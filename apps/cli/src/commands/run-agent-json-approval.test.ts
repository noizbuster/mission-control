import {
    type CommandExecutionRequest,
    type CommandExecutionResult,
    type ProviderAdapter,
    type ProviderTurnRequest,
} from '@mission-control/core';
import { AgentEventSchema, type AgentMessage, type ProviderStreamChunk } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { runAgent } from './run-agent.js';
import {
    knownSafePatchPath,
    lastRecord,
    parseJsonRecords,
    providerWithWrite,
} from './run-agent-json-approval-test-support.js';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('runAgent JSON non-interactive approvals', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('continues JSONL read-only tool calls with model-visible tool output', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-task18-data-');
        const workspaceRoot = await tempRoot('mctrl-task18-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        await writeFile(join(workspaceRoot, 'README.md'), 'task18 read result\n', 'utf8');
        const requests: ProviderTurnRequest[] = [];

        // When
        const output = await runAgent(
            parseArgs(['run', 'read README', '--jsonl', '--session', 'session_task18_read']),
            {
                workspaceRoot,
                provider: providerFromReadRequests(requests),
            },
        );
        const events = parseJsonEvents(output);

        // Then
        expect(requestAt(requests, 0).tools?.map((tool) => tool.name)).toEqual([
            'repo.read',
            'repo.list',
            'repo.search',
            'file.edit',
            'file.write',
            'file.patch',
            'command.run',
        ]);
        expect(requestAt(requests, 0).tools?.map((tool) => tool.name)).not.toEqual(
            expect.arrayContaining(['read', 'ls', 'grep', 'find']),
        );
        expect(requestAt(requests, 1).messages).toEqual([
            { role: 'user', content: 'read README' },
            { role: 'assistant', content: 'reading README' },
            {
                role: 'tool',
                toolCallId: 'task18_read_call',
                status: 'completed',
                output: expect.stringContaining('task18 read result'),
            },
        ]);
        expect(events.map((event) => event.type)).toEqual(expect.arrayContaining(['tool.completed', 'task.completed']));
        expect(events.find((event) => event.type === 'task.completed')?.message).toBe('final saw task18 read result');
    });

    it('blocks JSONL patch tools without prompting or modifying files when automation is absent', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-task18-block-data-');
        const workspaceRoot = await tempRoot('mctrl-task18-block-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);

        // When
        const output = await runAgent(
            parseArgs(['run', 'patch file', '--jsonl', '--session', 'session_task18_block']),
            {
                workspaceRoot,
                provider: providerWithPatch('.mctrl-task18-blocked.txt', 'blocked'),
            },
        );
        const events = parseJsonEvents(output);

        // Then
        expect(output).not.toContain('Approve file.patch?');
        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['approval.requested', 'approval.blocked']),
        );
        expect(events.some((event) => event.type === 'task.completed')).toBe(false);
        expect(JSON.stringify(events)).toContain('"policyDecision":"requires_approval"');
        await expect(readFile(join(workspaceRoot, '.mctrl-task18-blocked.txt'), 'utf8')).rejects.toThrow();
    });

    it('allows a named test automation policy to apply a safe patch and continue', async () => {
        // Given
        const dataDir = await tempRoot('mctrl-task18-allow-data-');
        const workspaceRoot = await tempRoot('mctrl-task18-allow-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const requests: ProviderTurnRequest[] = [];

        // When
        const output = await runAgent(
            parseArgs(['run', 'apply safe patch', '--jsonl', '--session', 'session_task18_allow']),
            {
                workspaceRoot,
                provider: providerFromPatchRequests(requests),
                commandExecutor: failCommandExecutor,
                nonInteractiveAutomationPolicy: 'test-only-allow-known-safe-patch',
            },
        );
        const events = parseJsonEvents(output);

        // Then
        expect(await readFile(join(workspaceRoot, knownSafePatchPath), 'utf8')).toBe('allowed\n');
        expect(requestAt(requests, 1).messages).toContainEqual({
            role: 'tool',
            toolCallId: 'task18_patch_call',
            status: 'completed',
            output: `applied patch to ${knownSafePatchPath}`,
        });
        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['file.diff.applied', 'tool.completed', 'task.completed']),
        );
        expect(events.some((event) => event.type === 'approval.blocked')).toBe(false);
        expect(events.find((event) => event.type === 'task.completed')?.message).toBe('patch applied after automation');
    });

    it('does not auto-approve file.write under the test-only safe patch automation policy', async () => {
        const dataDir = await tempRoot('mctrl-task18-write-data-');
        const workspaceRoot = await tempRoot('mctrl-task18-write-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);

        const output = await runAgent(
            parseArgs(['run', 'write file', '--jsonl', '--session', 'session_task18_write_blocked']),
            {
                workspaceRoot,
                provider: providerWithWrite('.mctrl-task18-write.txt', 'write blocked\n'),
                nonInteractiveAutomationPolicy: 'test-only-allow-known-safe-patch',
            },
        );
        const records = parseJsonRecords(output);

        expect(lastRecord(records)).toMatchObject({
            type: 'session.stopped',
            sessionId: 'session_task18_write_blocked',
            status: 'blocked_on_approval',
            approvalId: expect.stringMatching(/^approval_.+/),
        });
        await expect(readFile(join(workspaceRoot, '.mctrl-task18-write.txt'), 'utf8')).rejects.toThrow();
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});

function providerFromReadRequests(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            if (requests.length === 1) {
                yield toolCallChunk(request, 'task18_read_call', 'repo.read', { path: 'README.md' });
                yield completedChunk(request, 'reading README', ['task18_read_call']);
                return;
            }
            yield completedChunk(request, `final saw ${lastNonEmptyLine(lastToolOutput(request.messages))}`);
        },
    };
}

function providerWithPatch(path: string, content: string): ProviderAdapter {
    return {
        async *streamTurn(request) {
            yield toolCallChunk(request, 'task18_block_patch_call', 'file.patch', {
                patch: addFilePatch(path, content),
            });
            yield completedChunk(request, 'patch requested', ['task18_block_patch_call']);
        },
    };
}

function providerFromPatchRequests(requests: ProviderTurnRequest[]): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            if (requests.length === 1) {
                yield toolCallChunk(request, 'task18_patch_call', 'file.patch', {
                    patch: addFilePatch(knownSafePatchPath, 'allowed'),
                });
                yield completedChunk(request, 'patch requested', ['task18_patch_call']);
                return;
            }
            yield completedChunk(request, 'patch applied after automation');
        },
    };
}

async function failCommandExecutor(_request: CommandExecutionRequest): Promise<CommandExecutionResult> {
    throw new Error('command.run should not execute in the safe patch automation fixture');
}

function parseJsonEvents(output: string) {
    return output
        .trim()
        .split('\n')
        .filter((line) => line.trim().length > 0)
        .map((line) => AgentEventSchema.parse(JSON.parse(line)));
}

function toolCallChunk(
    request: ProviderTurnRequest,
    toolCallId: string,
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
): ProviderStreamChunk {
    return {
        kind: 'tool_call_completed',
        requestId: request.requestId,
        sequence: 1,
        toolCall: {
            toolCallId,
            toolName,
            argumentsJson: JSON.stringify(argumentsValue),
        },
    };
}

function completedChunk(
    request: ProviderTurnRequest,
    content: string,
    toolCallIds?: readonly string[],
): ProviderStreamChunk {
    return {
        kind: 'response_completed',
        requestId: request.requestId,
        sequence: 2,
        message: {
            messageId: `message_${request.turnId}`,
            role: 'assistant',
            content,
            ...(toolCallIds !== undefined ? { toolCallIds: [...toolCallIds] } : {}),
        },
        finishReason: toolCallIds === undefined ? 'stop' : 'tool_calls',
    };
}

function requestAt(requests: readonly ProviderTurnRequest[], index: number): ProviderTurnRequest {
    const request = requests[index];
    if (request === undefined) {
        throw new Error(`missing provider request at index ${index}`);
    }
    return request;
}

function lastNonEmptyLine(value: string | undefined): string {
    const lines = value?.split(/\r?\n/).filter((line) => line.trim().length > 0) ?? [];
    return lines.at(-1)?.trim() ?? 'missing tool output';
}

function lastToolOutput(messages: readonly AgentMessage[]): string | undefined {
    return [...messages].reverse().find((message): message is Extract<AgentMessage, { readonly role: 'tool' }> => {
        return message.role === 'tool';
    })?.output;
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
