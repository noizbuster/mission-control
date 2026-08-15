import { AgentRuntime, createDeterministicProvider, createObservabilityRedactor } from '@mission-control/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { createEmptyAuthStore } from './run-agent-chat-test-support';
import {
    type IsolatedMissionControlTestScope,
    useIsolatedMissionControlTestScope,
} from './run-agent-data-dir-test-support';
import { runInteractiveAgent } from './run-agent-interactive';

const createRunEventRecorderMock = vi.hoisted(() => vi.fn());
const runInteractiveChatSessionMock = vi.hoisted(() => vi.fn());

vi.mock('./run-agent-session.js', async () => {
    const actual = await vi.importActual<typeof import('./run-agent-session')>('./run-agent-session.js');
    return {
        ...actual,
        createRunEventRecorder: createRunEventRecorderMock,
    };
});

vi.mock('./interactive-chat.js', async () => {
    const actual = await vi.importActual<typeof import('./interactive-chat')>('./interactive-chat.js');
    return {
        ...actual,
        runInteractiveChatSession: runInteractiveChatSessionMock,
    };
});

vi.mock('./run-agent-model-selection.js', async () => {
    const actual = await vi.importActual<typeof import('./run-agent-model-selection')>(
        './run-agent-model-selection.js',
    );
    return {
        ...actual,
        listAuthenticatedModelChoices: async () => [],
    };
});

let testScope: IsolatedMissionControlTestScope | undefined;

beforeEach(async () => {
    testScope = await useIsolatedMissionControlTestScope('mctrl-teardown-fault-data-');
});

afterEach(async () => {
    createRunEventRecorderMock.mockReset();
    runInteractiveChatSessionMock.mockReset();
    vi.restoreAllMocks();
    await testScope?.cleanup();
    testScope = undefined;
});

describe('runInteractiveAgent teardown isolation', () => {
    it('does not let a recorder close failure mask the session result', async () => {
        createRunEventRecorderMock.mockResolvedValue({
            record: (event: unknown) => event,
            currentStore: () => undefined,
            currentSessionId: () => undefined,
            switchSession: async () => {
                throw new Error('unused');
            },
            ensureSession: async () => ({ sessionId: 'session_teardown_fault', store: undefined }),
            shouldFinalizeCurrentSession: () => false,
            close: async () => {
                throw new Error('recorder close boom');
            },
        });
        runInteractiveChatSessionMock.mockResolvedValue('session-done');
        const provider = createDeterministicProvider([]);

        const writes: string[] = [];
        const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation((data: unknown) => {
            writes.push(typeof data === 'string' ? data : String(data));
            return true;
        });
        try {
            const result = await runInteractiveAgent({
                args: parseArgs([]),
                runtime: new AgentRuntime(),
                authStore: createEmptyAuthStore(),
                provider,
                selectedModelProvider: { providerID: 'local', modelID: 'local-echo' },
                createProvider: () => provider,
                workspaceRoot: process.cwd(),
                config: {},
                persistentStore: undefined,
                observabilityRedactor: createObservabilityRedactor(),
                options: {},
            });

            expect(result).toBe('session-done');
            expect(writes.join('')).toContain('recorder close boom');
        } finally {
            stderrSpy.mockRestore();
        }
    });
});
