import type { LanguageModelV3StreamPart } from '@ai-sdk/provider';
import {
    AgentRuntime,
    createDeterministicProvider,
    openLocalSessionEventStore,
    type SdkModelResolver,
} from '@mission-control/core';
import { createChatTuiHandle } from '@mission-control/tui/create-chat-tui';
import { createChatStore } from '@mission-control/tui/state';
import { convertArrayToReadableStream, MockLanguageModelV3 } from 'ai/test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInteractiveChatSession } from './interactive-chat';
import { setTtyState } from './run-agent-chat-test-support';
import {
    type IsolatedMissionControlTestScope,
    useIsolatedMissionControlTestScope,
} from './run-agent-data-dir-test-support';
import { TERMINAL_TITLE_RESET, TERMINAL_TITLE_SET_PREFIX } from './terminal-controls';

const createChatTuiMock = vi.hoisted(() => vi.fn());
let testScope: IsolatedMissionControlTestScope | undefined;

vi.mock('@mission-control/tui/create-chat-tui', async () => {
    const actual = await vi.importActual<typeof import('@mission-control/tui/create-chat-tui')>(
        '@mission-control/tui/create-chat-tui',
    );
    return {
        ...actual,
        createChatTui: createChatTuiMock,
    };
});

beforeEach(async () => {
    testScope = await useIsolatedMissionControlTestScope('mctrl-terminal-title-data-');
});

afterEach(async () => {
    createChatTuiMock.mockReset();
    vi.restoreAllMocks();
    await testScope?.cleanup();
    testScope = undefined;
});

describe('runInteractiveChatSession terminal title management', () => {
    it('writes OSC title escapes without duplicating the TUI transcript to stdout', async () => {
        const restoreTtyState = setTtyState({ input: true, output: true });
        const store = createChatStore();
        store.enqueueEvent({ type: 'line', value: '/exit' });
        createChatTuiMock.mockImplementation(async () => createChatTuiHandle(store, () => {}));
        try {
            const { result, stderr } = await captureStderr(async () =>
                runInteractiveChatSession(new AgentRuntime(), {
                    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                    provider: createDeterministicProvider([]),
                }),
            );

            expect(createChatTuiMock).toHaveBeenCalledOnce();
            expect(result).toBe('');
            expect(store.getOutput()).toContain('Exiting mission-control chat');
            expect(stderr).toContain(`${TERMINAL_TITLE_SET_PREFIX}Mission Control`);
            expect(stderr).toContain(TERMINAL_TITLE_RESET);
        } finally {
            restoreTtyState();
        }
    });

    it('renders cumulative cache-read usage through the live TUI handle', async () => {
        const restoreTtyState = setTtyState({ input: true, output: true });
        const store = createChatStore();
        const dataDir = testScope?.dataDir;
        if (dataDir === undefined) throw new Error('expected isolated data directory');
        const sessionId = 'session_cache_usage';
        const sessionStore = await openLocalSessionEventStore({ dataDir, sessionId });
        store.enqueueEvent({ type: 'line', value: 'Report the cache usage.' });
        createChatTuiMock.mockImplementation(async () => createChatTuiHandle(store, () => {}));
        const stream: LanguageModelV3StreamPart[] = [
            { type: 'stream-start', warnings: [] },
            { type: 'text-start', id: 'text_cache' },
            { type: 'text-delta', id: 'text_cache', delta: 'Done.' },
            { type: 'text-end', id: 'text_cache' },
            {
                type: 'finish',
                finishReason: { unified: 'stop', raw: undefined },
                usage: {
                    inputTokens: { total: 12000, noCache: 4000, cacheRead: 8000, cacheWrite: 0 },
                    outputTokens: { total: 6, text: 6, reasoning: 0 },
                },
            },
        ];
        const model = new MockLanguageModelV3({
            provider: 'openai',
            modelId: 'gpt-cache-test',
            doStream: async () => ({ stream: convertArrayToReadableStream(stream) }),
        });
        const resolveSdkModel: SdkModelResolver = () => model;

        let session: Promise<string> | undefined;
        try {
            session = runInteractiveChatSession(new AgentRuntime(), {
                modelProviderSelection: { providerID: 'openai', modelID: 'gpt-cache-test' },
                provider: createDeterministicProvider([]),
                resolveSdkModel,
                sessionId,
                sessionStore,
                workspaceRoot: process.cwd(),
            });

            await vi.waitFor(() => {
                expect(store.getSnapshot().contextTokensUsed).toBe(12000);
            });
            await vi.waitFor(() => {
                expect(store.getSnapshot().contextCacheUsage).toEqual({
                    inputTokens: 12000,
                    cacheReadTokens: 8000,
                });
            });
            store.enqueueEvent({ type: 'line', value: '/exit' });
            await session;

            expect(store.getSnapshot().contextCacheUsage).toEqual({
                inputTokens: 12000,
                cacheReadTokens: 8000,
            });
        } finally {
            store.enqueueEvent({ type: 'line', value: '/exit' });
            await session?.catch(() => undefined);
            await sessionStore.close();
            restoreTtyState();
        }
    });
});

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ readonly result: T; readonly stderr: string }> {
    const writes: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((data: unknown) => {
        writes.push(typeof data === 'string' ? data : String(data));
        return true;
    });
    try {
        const result = await fn();
        return { result, stderr: writes.join('') };
    } finally {
        spy.mockRestore();
    }
}
