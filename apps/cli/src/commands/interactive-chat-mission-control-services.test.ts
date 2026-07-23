import { AgentRuntime, createDeterministicProvider, openLocalSessionEventStore } from '@mission-control/core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInteractiveChatSession } from './interactive-chat';
import { disposeAllMissionControlServices } from './mission-control-services';
import { createBufferedChatOutput, createScriptedChatInput } from './run-agent-chat-test-support';
import { RESUMABLE_ATTACH_BANNER } from './session-attach-projection';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const getOrCreateMissionControlServicesMock = vi.hoisted(() => vi.fn());

vi.mock('./mission-control-services.js', async () => {
    const actual = await vi.importActual<typeof import('./mission-control-services')>('./mission-control-services.js');
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
    it('degrades without task runtime services when .mc is missing', async () => {
        const dataDir = await tempRoot('mctrl-interactive-no-mc-data-');
        const workspaceRoot = await tempRoot('mctrl-interactive-no-mc-workspace-');
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

    it('restores an attached session transcript before accepting new input', async () => {
        const dataDir = await tempRoot('mctrl-interactive-attached-session-data-');
        const workspaceRoot = await tempRoot('mctrl-interactive-attached-session-workspace-');
        const sessionId = 'session_attached_interactive_resume';
        const store = await openLocalSessionEventStore({ dataDir, sessionId });
        await store.append({
            type: 'prompt.promoted',
            timestamp: '2026-07-23T00:00:00.000Z',
            sessionId,
            message: 'remember this conversation',
        });
        await store.append({
            type: 'model.call.completed',
            timestamp: '2026-07-23T00:00:01.000Z',
            sessionId,
            abg: {
                graphId: 'attached-session-graph',
                nodeId: 'assistant',
                nodeKind: 'llm',
                emit: {
                    type: 'llm.turn.completed',
                    payload: { text: 'I remember it.', usage: { inputTokens: 4200, outputTokens: 80 } },
                },
            },
        });
        await store.append({
            type: 'run.blocked',
            timestamp: '2026-07-23T00:00:02.000Z',
            sessionId,
            run: { runId: 'attached-run', state: 'blocked_on_approval', toolCallId: 'tool-attached' },
        });
        const chatOutput = createBufferedChatOutput();
        const stickyNotices: Array<string | null> = [];
        const outputWithStickyNotice = {
            ...chatOutput.output,
            setStickyNotice: (message: string | null) => {
                stickyNotices.push(message);
            },
        };

        try {
            const result = await runInteractiveChatSession(new AgentRuntime(), {
                input: createScriptedChatInput([{ type: 'line', value: '/exit' }], 0),
                output: outputWithStickyNotice,
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                provider: createDeterministicProvider([]),
                sessionId,
                sessionStore: store,
                workspaceRoot,
            });

            expect(result).toContain('You: remember this conversation');
            expect(result).toContain('Assistant: I remember it.');
            expect(stickyNotices).toEqual([RESUMABLE_ATTACH_BANNER.approval]);
        } finally {
            await store.close();
        }
    });

    it('restores prior transcript and resumable state through /session', async () => {
        const dataDir = await tempRoot('mctrl-interactive-session-switch-data-');
        const workspaceRoot = await tempRoot('mctrl-interactive-session-switch-workspace-');
        const currentSessionId = 'session_current_interactive_switch';
        const targetSessionId = 'session_target_interactive_switch';
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const currentStore = await openLocalSessionEventStore({ dataDir, sessionId: currentSessionId });
        const targetStore = await openLocalSessionEventStore({ dataDir, sessionId: targetSessionId });
        await targetStore.append({
            type: 'prompt.promoted',
            timestamp: '2026-07-23T01:00:00.000Z',
            sessionId: targetSessionId,
            message: 'restore this switched conversation',
        });
        await targetStore.append({
            type: 'model.call.completed',
            timestamp: '2026-07-23T01:00:01.000Z',
            sessionId: targetSessionId,
            abg: {
                graphId: 'switched-session-graph',
                nodeId: 'assistant',
                nodeKind: 'llm',
                emit: {
                    type: 'llm.turn.completed',
                    payload: {
                        text: 'The switched session is restored.',
                        usage: { inputTokens: 8400, outputTokens: 80 },
                    },
                },
            },
        });
        await targetStore.append({
            type: 'run.blocked',
            timestamp: '2026-07-23T01:00:02.000Z',
            sessionId: targetSessionId,
            run: { runId: 'switched-run', state: 'blocked_on_approval', toolCallId: 'tool-switched' },
        });
        const chatOutput = createBufferedChatOutput();

        try {
            const result = await runInteractiveChatSession(new AgentRuntime(), {
                input: createScriptedChatInput(
                    [
                        { type: 'line', value: `/session ${targetSessionId}` },
                        { type: 'line', value: '/exit' },
                    ],
                    0,
                ),
                output: chatOutput.output,
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                provider: createDeterministicProvider([]),
                sessionId: currentSessionId,
                sessionStore: currentStore,
                switchSessionStore: async () => targetStore,
                workspaceRoot,
            });

            expect(result).toContain('Switched to session: session_target_interactive_switch');
            expect(result).toContain('You: restore this switched conversation');
            expect(result).toContain('Assistant: The switched session is restored.');
            expect(result).toContain(RESUMABLE_ATTACH_BANNER.approval);
        } finally {
            await currentStore.close();
            await targetStore.close();
        }
    });
    it('rejects when MissionControlServices creation fails after .mc resolves', async () => {
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
