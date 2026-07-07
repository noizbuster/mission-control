import { AgentRuntime, JsonlSessionEventStore, type ProviderAdapter } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { startPromptTurn } from './interactive-chat-prompt-turn.js';
import { MissionControlServices, resetMissionControlServicesCache } from './mission-control-services.js';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const startCodingAgentTurnMock = vi.hoisted(() =>
    vi.fn(async () => ({
        done: Promise.resolve(),
        interrupt: () => undefined,
        answerApproval: () => false,
        hasPendingApproval: () => false,
        setApprovalLevel: () => undefined,
    })),
);

vi.mock('./interactive-coding-agent.js', () => ({
    startCodingAgentTurn: startCodingAgentTurnMock,
}));

const roots: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    startCodingAgentTurnMock.mockClear();
    resetMissionControlServicesCache();
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('startPromptTurn task services wiring', () => {
    it('passes task runtime services into interactive coding-agent turns', async () => {
        const dataDir = await tempRoot('mctrl-interactive-task-data-');
        const workspaceRoot = await tempRoot('mctrl-interactive-task-workspace-');
        await mkdir(join(workspaceRoot, '.omo'), { recursive: true });
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const sessionId = 'session_interactive_task_services';
        const store = await JsonlSessionEventStore.open({ sessionId, dataDir });
        const services = await MissionControlServices.create(workspaceRoot);
        const taskRuntimeServices = services.getTaskRuntimeServices();

        try {
            await startPromptTurn(
                new AgentRuntime(),
                { write: () => undefined },
                'interactive prompt',
                { providerID: 'local', modelID: 'local-echo' },
                {
                    provider: unusedProvider,
                    sessionId,
                    workspaceRoot,
                    sessionStore: store,
                    commandExecutor: undefined,
                    nextTurnId: () => 'turn_interactive_services',
                    emitEvent: () => undefined,
                    observeStoredEvent: () => undefined,
                    taskRuntimeServices,
                },
            );
        } finally {
            await services.dispose();
            await store.close();
        }

        expect(startCodingAgentTurnMock).toHaveBeenCalledTimes(1);
        expect(startCodingAgentTurnMock).toHaveBeenCalledWith(
            expect.objectContaining({
                sessionId,
                workspaceRoot,
                taskRuntimeServices,
            }),
        );
    });
});

async function tempRoot(prefix: string): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), prefix));
    roots.push(root);
    return root;
}

const unusedProvider: ProviderAdapter = {
    streamTurn: async function* () {
        yield {
            kind: 'response_completed',
            requestId: 'unused_request',
            sequence: 1,
            message: {
                messageId: 'unused_message',
                role: 'assistant',
                content: 'unused',
            },
            finishReason: 'stop',
        };
    },
};
