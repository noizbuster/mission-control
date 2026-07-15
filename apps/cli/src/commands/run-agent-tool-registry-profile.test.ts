import type { ProviderTurnRequest } from '@mission-control/core';
import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { createNonInteractiveToolRegistry } from './noninteractive-tool-registry';
import { runAgent } from './run-agent';
import {
    createBufferedChatOutput,
    createEmptyAuthStore,
    createScriptedChatInput,
} from './run-agent-chat-test-support';
import {
    firstAdvertisedToolNames,
    mcpFixturePath,
    providerFromTurns,
    tempRoot,
    writeToolWorkflow,
} from './run-agent-tool-registry-test-support';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

describe('runAgent profile MCP tool registry', () => {
    const tempRoots: string[] = [];

    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempRoots.map((path) => rm(path, { recursive: true, force: true })));
        tempRoots.length = 0;
    });

    it('advertises profile server tools and not base config tools in interactive mode', async () => {
        const configDir = await tempRoot(tempRoots, 'mctrl-profile-cfg-');
        const dataDir = await tempRoot(tempRoots, 'mctrl-profile-data-');
        const workspaceRoot = await tempRoot(tempRoots, 'mctrl-profile-ws-');
        await writeToolWorkflow(workspaceRoot, 'profile-tools');
        await writeProfileAndBaseConfigs(configDir);

        vi.stubEnv('MCTRL_CONFIG_DIR', configDir);
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);

        const requests: ProviderTurnRequest[] = [];
        const chatOutput = createBufferedChatOutput();

        await runAgent(parseArgs(['--profile', 'dev', '--session', 'session_profile_mcp_interactive']), {
            authStore: createEmptyAuthStore(),
            chatInput: createScriptedChatInput(
                [{ type: 'line', value: '#profile-tools hello' }, { type: 'interrupt' }, { type: 'interrupt' }],
                50,
            ),
            chatOutput: chatOutput.output,
            workspaceRoot,
            provider: providerFromTurns(requests, [[{ kind: 'response_completed', content: 'done' }]]),
        });

        const toolNames = firstAdvertisedToolNames(requests);
        expect(toolNames).toContain('mcp__profile_only__echo');
        expect(toolNames.some((name) => name.startsWith('mcp__base_only__'))).toBe(false);
    }, 20000);

    it('advertises profile server tools and not base config tools in noninteractive mode', async () => {
        const configDir = await tempRoot(tempRoots, 'mctrl-profile-cfg-ni-');
        const workspaceRoot = await tempRoot(tempRoots, 'mctrl-profile-ws-ni-');
        await writeProfileAndBaseConfigs(configDir);

        vi.stubEnv('MCTRL_CONFIG_DIR', configDir);

        const alwaysAllow = async (request: PermissionRequest): Promise<PermissionDecision> => ({
            requestId: request.id,
            status: 'allow',
            reason: 'test',
        });

        const { registry, mcpConnectionManager } = await createNonInteractiveToolRegistry({
            workspaceRoot,
            requestPermission: alwaysAllow,
            profileName: 'dev',
        });
        try {
            const toolNames = registry.advertise().map((tool) => tool.name);
            expect(toolNames).toContain('mcp__profile_only__echo');
            expect(toolNames.some((name) => name.startsWith('mcp__base_only__'))).toBe(false);
        } finally {
            await mcpConnectionManager.disconnectAll();
        }
    }, 20000);
});

async function writeProfileAndBaseConfigs(configDir: string): Promise<void> {
    await writeFile(
        join(configDir, 'mission-control.dev.jsonc'),
        JSON.stringify({
            mcp: {
                'profile-only': {
                    type: 'local',
                    command: [process.execPath, mcpFixturePath, 'normal'],
                    timeoutMs: 5000,
                },
            },
        }),
        'utf8',
    );
    await writeFile(
        join(configDir, 'config.json'),
        JSON.stringify({
            mcp: {
                'base-only': {
                    type: 'local',
                    command: [process.execPath, mcpFixturePath, 'normal'],
                    timeoutMs: 5000,
                },
            },
        }),
        'utf8',
    );
}
