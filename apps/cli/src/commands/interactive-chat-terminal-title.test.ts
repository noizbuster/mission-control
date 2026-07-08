import { AgentRuntime, createDeterministicProvider } from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createChatStore } from './chat-store.js';
import type { ChatTuiHandle } from './chat-tui-types.js';
import { createChatTuiHandle } from './create-chat-tui.js';
import { runInteractiveChatSession } from './interactive-chat.js';
import { setTtyState } from './run-agent-chat-test-support.js';
import {
    type IsolatedMissionControlTestScope,
    useIsolatedMissionControlTestScope,
} from './run-agent-data-dir-test-support.js';
import { TERMINAL_TITLE_RESET, TERMINAL_TITLE_SET_PREFIX } from './terminal-controls.js';

const createChatTuiMock = vi.hoisted(() => vi.fn());
let testScope: IsolatedMissionControlTestScope | undefined;

vi.mock('./create-chat-tui.js', async () => {
    const actual = await vi.importActual<typeof import('./create-chat-tui.js')>('./create-chat-tui.js');
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
    it('writes OSC title escapes for TUI-capable TTY sessions without mounting OpenTUI', async () => {
        const restoreTtyState = setTtyState({ input: true, output: true });
        createChatTuiMock.mockImplementation(async () => createExitOnlyTuiHandle());
        try {
            const { result, stderr } = await captureStderr(async () =>
                runInteractiveChatSession(new AgentRuntime(), {
                    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                    provider: createDeterministicProvider([]),
                }),
            );

            expect(createChatTuiMock).toHaveBeenCalledOnce();
            expect(result).toContain('Exiting mission-control chat');
            expect(stderr).toContain(`${TERMINAL_TITLE_SET_PREFIX}Mission Control`);
            expect(stderr).toContain(TERMINAL_TITLE_RESET);
        } finally {
            restoreTtyState();
        }
    });
});

function createExitOnlyTuiHandle(): ChatTuiHandle {
    const store = createChatStore();
    store.enqueueEvent({ type: 'line', value: '/exit' });
    return createChatTuiHandle(store, () => {});
}

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
