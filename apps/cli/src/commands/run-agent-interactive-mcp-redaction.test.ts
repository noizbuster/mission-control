import { missionControlDataDirEnvKey, readLocalSessionReplay } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { runAgent } from './run-agent';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support';
import { providerFromTurns } from './run-agent-tool-registry-test-support';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('interactive MCP credential redaction', () => {
    const tempRoots: string[] = [];
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
    });

    it('uses configured MCP secrets when redacting approval events and output', async () => {
        const dataDir = await tempRoot('mctrl-mcp-approval-data-');
        const configDir = await tempRoot('mctrl-mcp-approval-config-');
        const workspaceRoot = await tempRoot('mctrl-mcp-approval-workspace-');
        const sessionId = 'session_cli_mcp_approval_redaction';
        const secret = ['mcp', 'approval', 'credential'].join('_');
        vi.stubEnv(missionControlDataDirEnvKey, dataDir);
        vi.stubEnv('MCTRL_CONFIG_DIR', configDir);
        await mkdir(configDir, { recursive: true });
        await writeFile(
            join(configDir, 'config.json'),
            JSON.stringify({
                mcp: {
                    inactive: {
                        type: 'local',
                        enabled: false,
                        command: ['unused'],
                        environment: { API_TOKEN: secret },
                    },
                },
            }),
            'utf8',
        );
        const output = await runAgent(parseArgs(['--session', sessionId]), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput([
                { type: 'line', value: 'request a command approval' },
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
                            toolCallId: 'mcp_approval_secret',
                            toolName: 'command.run',
                            argumentsJson: JSON.stringify({
                                command: 'pnpm',
                                args: ['exec', 'vitest', 'run', `${secret}.test.ts`],
                            }),
                        },
                        { kind: 'response_completed', content: 'requested approval' },
                    ],
                    [{ kind: 'response_completed', content: 'adapted after denial' }],
                ],
            ),
        });
        const replay = await readLocalSessionReplay({ dataDir, sessionId });
        if (replay.kind !== 'found') throw new Error(`expected replay for ${sessionId}`);
        const observable = JSON.stringify({ output, storedReplay: replay.replay });
        expect(observable).toContain('[REDACTED_CREDENTIAL]');
        expect(observable).not.toContain(secret);
    });

    async function tempRoot(prefix: string): Promise<string> {
        const path = await mkdtemp(join(tmpdir(), prefix));
        tempRoots.push(path);
        return path;
    }
});
