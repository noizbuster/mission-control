import { AgentRuntime, createDeterministicProvider } from '@mission-control/core';
import { createChatTuiHandle } from '@mission-control/tui/create-chat-tui';
import { createChatStore } from '@mission-control/tui/state';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crashGuardActiveSession, resetCrashGuardForTests } from '../crash-guard';
import { resetInputHistoryStoreForTests } from './input-history-store';
import { runInteractiveChatSession } from './interactive-chat';
import { createBufferedChatOutput, createScriptedChatInput, setTtyState } from './run-agent-chat-test-support';
import {
    type IsolatedMissionControlTestScope,
    useIsolatedMissionControlTestScope,
} from './run-agent-data-dir-test-support';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
    resetInputHistoryStoreForTests();
    testScope = await useIsolatedMissionControlTestScope('mctrl-signal-rescue-data-');
});

afterEach(async () => {
    createChatTuiMock.mockReset();
    vi.restoreAllMocks();
    await testScope?.cleanup();
    testScope = undefined;
});

describe('runInteractiveChatSession out-of-band signal rescue (TUI mode)', () => {
    it('starts fresh with a notice when boot input history cannot be read', async () => {
        const restoreTtyState = setTtyState({ input: true, output: true });
        const dataDir = testScope?.dataDir;
        if (dataDir === undefined) throw new Error('expected isolated data directory');
        // A directory at the history file path makes the boot load reject (EISDIR).
        await mkdir(join(dataDir, 'input-history.json'));
        const store = createChatStore();
        const noticedMessages = new Set<string>();
        const unsubscribeNotices = store.subscribe(() => {
            const notice = store.getSnapshot().transientNotice;
            if (notice !== undefined && notice !== null) {
                noticedMessages.add(notice.message);
            }
        });
        store.enqueueEvent({ type: 'line', value: '/exit' });
        createChatTuiMock.mockImplementation(async () => createChatTuiHandle(store, () => {}));

        try {
            await runInteractiveChatSession(new AgentRuntime(), {
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                provider: createDeterministicProvider([]),
            });

            expect(store.getOutput()).toContain('Exiting mission-control chat');
            expect([...noticedMessages].join('\n')).toContain('Input history unavailable');
        } finally {
            unsubscribeNotices();
            restoreTtyState();
        }
    });

    it('flushes the prompt draft, closes the event queue, and exits on SIGINT', async () => {
        const restoreTtyState = setTtyState({ input: true, output: true });
        const store = createChatStore();
        createChatTuiMock.mockImplementation(async () => createChatTuiHandle(store, () => {}));
        const flushSpy = vi.fn();
        const host = globalThis as typeof globalThis & { __mcFlushPromptDraft?: () => void };
        host.__mcFlushPromptDraft = flushSpy;
        const baselineSigintListeners = process.listenerCount('SIGINT');
        let session: Promise<string> | undefined;
        try {
            const writes: string[] = [];
            const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((data: unknown) => {
                writes.push(typeof data === 'string' ? data : String(data));
                return true;
            });
            try {
                session = runInteractiveChatSession(new AgentRuntime(), {
                    modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                    provider: createDeterministicProvider([]),
                });
                // Wait until the loop's signal registration is live.
                await vi.waitFor(() => {
                    expect(process.listenerCount('SIGINT')).toBeGreaterThan(baselineSigintListeners);
                });

                process.emit('SIGINT');

                const result = await session;
                expect(result).toBe('');
            } finally {
                stderrSpy.mockRestore();
            }

            // Draft flush ran before teardown (omp postmortem order).
            expect(flushSpy).toHaveBeenCalled();
            // The loop was woken through a closed event queue, not a hang.
            expect(store.isEventQueueClosed()).toBe(true);
            // Registration removed after the loop exited.
            expect(process.listenerCount('SIGINT')).toBe(baselineSigintListeners);
            // Finalize line still reaches the terminal (mirrored to stderr).
            expect(writes.join('')).toContain('Session aborted');
        } finally {
            delete host.__mcFlushPromptDraft;
            store.enqueueEvent({ type: 'line', value: '/exit' });
            await session?.catch(() => undefined);
            restoreTtyState();
        }
    });
});

describe('crash guard active session registration', () => {
    afterEach(() => {
        resetCrashGuardForTests();
    });

    it('registers the resumed session id with the crash guard', async () => {
        const chatOutput = createBufferedChatOutput();

        const output = await runInteractiveChatSession(new AgentRuntime(), {
            input: createScriptedChatInput([{ type: 'line', value: '/exit' }], 0),
            output: chatOutput.output,
            modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
            provider: createDeterministicProvider([]),
            sessionId: 'session_crash_guard_attribution',
        });

        expect(output).toContain('Exiting mission-control chat');
        expect(crashGuardActiveSession()).toBe('session_crash_guard_attribution');
    });
});
