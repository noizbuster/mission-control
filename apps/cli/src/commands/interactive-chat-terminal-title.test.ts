import { AgentRuntime, createDeterministicProvider } from '@mission-control/core';
import { createChatTuiHandle } from '@mission-control/tui/create-chat-tui';
import { createChatStore } from '@mission-control/tui/state';
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
