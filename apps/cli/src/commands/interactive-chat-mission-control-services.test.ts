import { AgentRuntime, createDeterministicProvider } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInteractiveChatSession } from './interactive-chat';
import { disposeAllMissionControlServices } from './mission-control-services';
import { createBufferedChatOutput, createScriptedChatInput } from './run-agent-chat-test-support';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getOrCreateMissionControlServicesMock = vi.hoisted(() => vi.fn());

vi.mock('./mission-control-services.js', async () => {
    const actual = await vi.importActual<typeof import('./mission-control-services')>(
        './mission-control-services.js',
    );
    return {
        ...actual,
        getOrCreateMissionControlServices: getOrCreateMissionControlServicesMock,
    };
});

const roots: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    getOrCreateMissionControlServicesMock.mockReset();
    await disposeAllMissionControlServices();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('runInteractiveChatSession MissionControlServices error handling', () => {
    it('degrades without task runtime services when .omo is missing', async () => {
        const dataDir = await tempRoot('mctrl-interactive-no-omo-data-');
        const workspaceRoot = await tempRoot('mctrl-interactive-no-omo-workspace-');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const actual = await vi.importActual<typeof import('./mission-control-services')>(
            './mission-control-services.js',
        );
        getOrCreateMissionControlServicesMock.mockImplementation(actual.getOrCreateMissionControlServices);
        const chatOutput = createBufferedChatOutput();

        const output = await runInteractiveChatSession(new AgentRuntime(), {
            input: createScriptedChatInput([{ type: 'line', value: '/exit' }], 0),
            output: chatOutput.output,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            workspaceRoot,
            provider: createDeterministicProvider([]),
        });

        expect(output).toContain('Exiting mission-control chat');
    });

    it('rejects when MissionControlServices creation fails after .omo resolves', async () => {
        const dataDir = await tempRoot('mctrl-interactive-bad-services-data-');
        const workspaceRoot = await tempRoot('mctrl-interactive-bad-services-workspace-');
        const serviceError = new Error('synthetic MissionControlServices failure');
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        getOrCreateMissionControlServicesMock.mockRejectedValue(serviceError);
        const chatOutput = createBufferedChatOutput();

        await expect(
            runInteractiveChatSession(new AgentRuntime(), {
                input: createScriptedChatInput([{ type: 'line', value: '/exit' }], 0),
                output: chatOutput.output,
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                workspaceRoot,
                provider: createDeterministicProvider([]),
            }),
        ).rejects.toBe(serviceError);
    });
});

async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}
