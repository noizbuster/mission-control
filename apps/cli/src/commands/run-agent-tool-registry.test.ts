import type { ProviderTurnRequest } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { runAgent } from './run-agent';
import { createBufferedChatOutput, createEmptyAuthStore, createScriptedChatInput } from './run-agent-chat-test-support';
import {
    addFilePatch,
    fakeCommandExecutor,
    firstAdvertisedToolNames,
    providerFromTurns,
    tempRoot,
} from './run-agent-tool-registry-test-support';
import { replayedTypes } from './session-replay-test-support';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('runAgent interactive coding tool registry', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('advertises coding-agent aliases and executes ls plus read before approved file.patch', async () => {
        const dataDir = await tempRoot(tempRoots, 'mctrl-tools-data-');
        const workspaceRoot = await tempRoot(tempRoots, 'mctrl-tools-workspace-');
        await mkdir(join(workspaceRoot, 'src'));
        await writeFile(join(workspaceRoot, 'src', 'index.ts'), 'export const value = 1;\n', 'utf8');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        vi.stubEnv('GEMINI_API_KEY', '');
        vi.stubEnv('GOOGLE_API_KEY', '');
        vi.stubEnv('OPENAI_API_KEY', '');
        vi.stubEnv('XAI_API_KEY', '');
        const chatOutput = createBufferedChatOutput();
        const requests: ProviderTurnRequest[] = [];
        const events: AgentEvent[] = [];

        const output = await runAgent(parseArgs(['--session', 'session_task4_tools']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput(
                [
                    { type: 'line', value: 'inspect workspace then patch' },
                    { type: 'line', value: 'y' },
                    { type: 'interrupt' },
                    { type: 'interrupt' },
                ],
                300,
            ),
            chatOutput: chatOutput.output,
            workspaceRoot,
            commandExecutor: fakeCommandExecutor,
            provider: providerFromTurns(requests, [
                [
                    {
                        kind: 'tool_call_completed',
                        toolCallId: 'list_call',
                        toolName: 'ls',
                        argumentsJson: JSON.stringify({ path: '.' }),
                    },
                    {
                        kind: 'tool_call_completed',
                        toolCallId: 'read_call',
                        toolName: 'read',
                        argumentsJson: JSON.stringify({ path: 'src/index.ts' }),
                    },
                    {
                        kind: 'tool_call_completed',
                        toolCallId: 'patch_call',
                        toolName: 'file.patch',
                        argumentsJson: JSON.stringify({ patch: addFilePatch('.mctrl-task4.txt', 'approved') }),
                    },
                    { kind: 'response_completed', content: 'inspected workspace and patched' },
                ],
            ]),
            onRuntimeEvent: (event) => {
                events.push(event);
            },
            plainPromptGraph: 'coding-agent',
        });

        expect(firstAdvertisedToolNames(requests)).toEqual([
            'repo.read',
            'repo.list',
            'repo.search',
            'read',
            'ls',
            'grep',
            'find',
            'repo.read.tagged',
            'session_list',
            'session_read',
            'session_info',
            'session_search',
            'glob',
            'ast_grep',
            'ast_edit',
            'resolve',
            'todowrite',
            'skill',
            'workflow',
            'webfetch',
            'file.edit',
            'file.write',
            'file.patch',
            'hashline_edit',
            'command.run',
            'look_at',
            'inspect_image',
            'checkpoint',
            'rewind',
            'task',
            'lsp',
            'lsp_rename',
        ]);
        expect(output).not.toContain('Approve ls?');
        expect(output).not.toContain('Approve read?');
        expect(output).toContain('Approve file.patch? [once/always/deny]:');
        expect(output).toContain('Applied patch: .mctrl-task4.txt');
        expect(await readFile(join(workspaceRoot, '.mctrl-task4.txt'), 'utf8')).toBe('approved\n');
        expect(events).toContainEqual(
            expect.objectContaining({
                type: 'tool.completed',
                taskId: 'read_call',
            }),
        );
        expect(events.map((event) => event.type)).toEqual(
            expect.arrayContaining(['tool.completed', 'file.diff.applied']),
        );
        expect(await replayedTypes('session_task4_tools')).toEqual(
            expect.arrayContaining(['tool.completed', 'file.diff.applied']),
        );
    });

    it('denies read of reference repos without an approval prompt', async () => {
        const dataDir = await tempRoot(tempRoots, 'mctrl-tools-data-');
        const workspaceRoot = await tempRoot(tempRoots, 'mctrl-tools-workspace-');
        await mkdir(join(workspaceRoot, 'temp', 'ref-repos', 'opencode'), { recursive: true });
        await writeFile(join(workspaceRoot, 'temp', 'ref-repos', 'opencode', 'README.md'), 'hidden', 'utf8');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const chatOutput = createBufferedChatOutput();

        const output = await runAgent(parseArgs(['--session', 'session_task4_deny_read']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'read reference repo' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: chatOutput.output,
            workspaceRoot,
            provider: providerFromTurns(
                [],
                [
                    [
                        {
                            kind: 'tool_call_completed',
                            toolCallId: 'read_denied',
                            toolName: 'read',
                            argumentsJson: JSON.stringify({ path: 'temp/ref-repos/opencode/README.md' }),
                        },
                        {
                            kind: 'tool_call_completed',
                            toolCallId: 'repo_read_denied',
                            toolName: 'repo.read',
                            argumentsJson: JSON.stringify({ path: 'temp/ref-repos/opencode/README.md' }),
                        },
                        { kind: 'response_completed', content: 'read denied by registry' },
                    ],
                    [{ kind: 'response_completed', content: 'read denied' }],
                ],
            ),
            plainPromptGraph: 'coding-agent',
        });

        expect(output).not.toContain('Approve read?');
        expect(output).not.toContain('Approve repo.read?');
        expect(output).toContain('read failed: workspace_denied');
        expect(output).toContain('repo.read failed: workspace_denied');
    });
});
