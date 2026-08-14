import { AgentRuntime, createDeterministicProvider } from '@mission-control/core';
import { createChatTuiHandle } from '@mission-control/tui/create-chat-tui';
import { createChatStore } from '@mission-control/tui/state';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runInteractiveChatSession } from './interactive-chat';
import { disposeAllMissionControlServices, type MissionControlServices } from './mission-control-services';
import { setTtyState } from './run-agent-chat-test-support';

const createChatTuiMock = vi.hoisted(() => vi.fn());
const actualFactory = vi.hoisted(() => vi.fn());

vi.mock('@mission-control/tui/create-chat-tui', async () => {
    const actual = await vi.importActual<typeof import('@mission-control/tui/create-chat-tui')>(
        '@mission-control/tui/create-chat-tui',
    );
    return {
        ...actual,
        createChatTui: createChatTuiMock,
    };
});

vi.mock('./mission-control-services.js', async () => {
    const actual = await vi.importActual<typeof import('./mission-control-services')>(
        './mission-control-services.js',
    );
    return {
        ...actual,
        getOrCreateMissionControlServices: actualFactory,
    };
});

const tempDirs: string[] = [];

afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    createChatTuiMock.mockReset();
    actualFactory.mockReset();
    await disposeAllMissionControlServices();
    // Late session-close writes race the cleanup; ENOTEMPTY retries absorb it.
    await Promise.all(
        tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })),
    );
});

describe('runInteractiveChatSession background job settlement toast', () => {
    it('forwards onTerminalJob to the services factory and toasts settlement through the live TUI handle', async () => {
        // Given: a real workspace root (with .mc) and the real services factory,
        // wrapped only to capture the options the loop passes.
        const dataDir = await tempRoot('mctrl-toast-data-');
        const workspaceRoot = await tempRoot('mctrl-toast-workspace-');
        await mkdir(join(workspaceRoot, '.mc'), { recursive: true });
        vi.stubEnv('MCTRL_DATA_DIR', dataDir);
        const actual = await vi.importActual<typeof import('./mission-control-services')>(
            './mission-control-services.js',
        );
        let capturedOnTerminalJob: unknown;
        const servicesPromise = Promise.withResolvers<MissionControlServices>();
        actualFactory.mockImplementation((root: string, options: unknown) => {
            capturedOnTerminalJob = (options as { onTerminalJob?: unknown } | undefined)?.onTerminalJob;
            return actual
                .getOrCreateMissionControlServices(
                    root,
                    options as Parameters<typeof actual.getOrCreateMissionControlServices>[1],
                )
                .then((services) => {
                    servicesPromise.resolve(services);
                    return services;
                });
        });

        // And: a live TUI store whose notice we observe, a chat input that only
        // exits after the toast landed, and a background job started at mount.
        const restoreTtyState = setTtyState({ input: true, output: true });
        const store = createChatStore();
        const notices: string[] = [];
        const toastLanded = Promise.withResolvers<void>();
        const noticeSpy = vi.spyOn(store, 'showTransientNotice').mockImplementation((message: string) => {
            notices.push(message);
            toastLanded.resolve();
            // Exit through the store event queue once the toast landed.
            store.enqueueEvent({ type: 'line', value: '/exit' });
        });
        createChatTuiMock.mockImplementation(async () => {
            void servicesPromise.promise.then((services) => {
                services.getJobManager().startJob({
                    sessionId: 'session_job_toast',
                    agentId: 'explorer',
                    execute: async () => ({ status: 'completed' as const, output: 'job done' }),
                });
            });
            return createChatTuiHandle(store, () => {});
        });

        try {
            // When: no input/output overrides — the TUI path drives chat through
            // the store's event queue.
            await runInteractiveChatSession(new AgentRuntime(), {
                modelProviderSelection: { providerID: 'local', modelID: 'local-echo' },
                provider: createDeterministicProvider([]),
                workspaceRoot,
            });

            // Then: the loop registered the terminal listener with the factory
            // and the settled job surfaced as a TUI transient notice.
            expect(typeof capturedOnTerminalJob).toBe('function');
            expect(notices.some((message) => message.includes('Background job explorer completed'))).toBe(true);
            expect(store.getOutput()).toContain('Exiting mission-control chat');
            expect(noticeSpy).toHaveBeenCalled();
        } finally {
            restoreTtyState();
        }
    }, 20_000);
});

async function tempRoot(prefix: string): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
}
