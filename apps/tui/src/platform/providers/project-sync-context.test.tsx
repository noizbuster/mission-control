import type { AgentEvent, AgentSnapshot } from '@mission-control/protocol';
import { createRoot, type JSX } from 'solid-js';
import { createComponent } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import { createChatStore } from '../../state/chat-store.js';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types.js';
import {
    composeMissionControlProviderTree,
    type MissionControlTuiProviderEnvironment,
    type TuiKeymapProviderComponent,
    useTuiEvents,
    useTuiProject,
    useTuiSync,
} from './index.js';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';

type TestRenderer = {
    readonly id: string;
    copyToClipboardOSC52(text: string): boolean;
    isOsc52Supported(): boolean;
};

type TempProviderRoots = {
    readonly workspace: string;
    readonly dataDir: string;
    readonly configDir: string;
};

type RuntimeEventHarness = {
    readonly emit: (event: AgentEvent) => void;
    readonly subscribeCalls: () => number;
    readonly unsubscribeCalls: () => number;
    readonly subscribeEvents: NonNullable<ChatTuiRuntimeOptions['subscribeEvents']>;
};

type RenderedProjectSync = {
    readonly project: ReturnType<typeof useTuiProject>;
    readonly events: ReturnType<typeof useTuiEvents>;
    readonly sync: ReturnType<typeof useTuiSync>;
    readonly dispose: () => void;
};

const timestamp = '2026-01-01T00:00:00.000Z';
const laterTimestamp = '2026-01-01T00:00:01.000Z';
const latestTimestamp = '2026-01-01T00:00:02.000Z';

function makeTempProviderRoots(): TempProviderRoots {
    const base = mkdtempSync(join(tmpdir(), 'mctrl-tui-project-sync-'));
    const workspace = join(base, 'workspace');
    const dataDir = join(base, 'data');
    const configDir = join(base, 'config');
    mkdirSync(workspace, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    mkdirSync(configDir, { recursive: true });
    return { workspace, dataDir, configDir };
}

function makeProviderEnvironment(roots: TempProviderRoots): MissionControlTuiProviderEnvironment {
    return {
        env: {
            MCTRL_DATA_DIR: roots.dataDir,
            MCTRL_CONFIG_DIR: roots.configDir,
        },
        now: () => 1234,
    };
}

function createRuntimeEventHarness(): RuntimeEventHarness {
    let listener: ((event: AgentEvent) => void) | undefined;
    let subscribeCount = 0;
    let unsubscribeCount = 0;
    return {
        subscribeEvents: (nextListener) => {
            subscribeCount += 1;
            listener = nextListener;
            return () => {
                unsubscribeCount += 1;
                listener = undefined;
            };
        },
        emit: (event) => {
            listener?.(event);
        },
        subscribeCalls: () => subscribeCount,
        unsubscribeCalls: () => unsubscribeCount,
    };
}

function makeRuntimeOptions(
    roots: TempProviderRoots,
    overrides: Partial<ChatTuiRuntimeOptions> = {},
): ChatTuiRuntimeOptions {
    return {
        providerID: 'openai',
        modelID: 'gpt-5.5',
        variantID: 'reasoning-high',
        sessionID: 'runtime-session',
        workspaceRoot: roots.workspace,
        gitBranch: 'feature/projections',
        isWorktree: true,
        ...overrides,
    };
}

function renderProjectSync(options: ChatTuiRuntimeOptions, roots: TempProviderRoots): RenderedProjectSync {
    const renderer: TestRenderer = {
        id: 'renderer',
        copyToClipboardOSC52: () => true,
        isOsc52Supported: () => true,
    };
    const keymapProvider: TuiKeymapProviderComponent<TestRenderer> = (props) => props.children;
    const chatStore = createChatStore({ workspaceRoot: roots.workspace });
    chatStore.setSessionId('chat-store-session');
    let observed:
        | {
              readonly project: ReturnType<typeof useTuiProject>;
              readonly events: ReturnType<typeof useTuiEvents>;
              readonly sync: ReturnType<typeof useTuiSync>;
          }
        | undefined;
    let disposeRoot = (): void => {};

    function Consumer(): JSX.Element {
        observed = {
            project: useTuiProject(),
            events: useTuiEvents(),
            sync: useTuiSync(),
        };
        return null;
    }

    createRoot((dispose) => {
        disposeRoot = dispose;
        composeMissionControlProviderTree({
            useRenderer: () => renderer,
            keymapProvider,
            runtimeOptions: options,
            environment: makeProviderEnvironment(roots),
            chatStore,
            get children() {
                return createComponent(Consumer, {});
            },
        });
    });

    if (observed === undefined) {
        throw new Error('project sync provider consumer did not render');
    }
    return { ...observed, dispose: disposeRoot };
}

function runStartedEvent(): AgentEvent {
    return { type: 'run.started', timestamp };
}

function graphEvent(type: 'graph.started' | 'graph.completed', graphId: string): AgentEvent {
    return { type, timestamp, abg: { graphId } };
}

function toolStartedEvent(): AgentEvent {
    return {
        type: 'tool.started',
        timestamp,
        taskId: 'tool-1',
        message: 'starting tool',
    };
}

function toolCompletedEvent(): AgentEvent {
    return {
        type: 'tool.completed',
        timestamp: laterTimestamp,
        taskId: 'tool-1',
        message: 'tool complete',
        toolResult: {
            toolCallId: 'tool-1',
            status: 'completed',
            output: 'ok',
        },
    };
}

function approvalEvent(
    state: 'pending' | 'approved',
    eventType: 'approval.requested' | 'approval.updated',
): AgentEvent {
    return {
        type: eventType,
        timestamp: state === 'pending' ? timestamp : latestTimestamp,
        approvalRecord: {
            approvalId: 'approval-1',
            requestId: 'request-1',
            policyDecision: 'requires_approval',
            state,
            subject: { kind: 'tool', id: 'tool-1' },
            requestedAt: timestamp,
            ...(state === 'approved' ? { decidedAt: latestTimestamp } : {}),
        },
    };
}

function awaitingSnapshot(): AgentSnapshot {
    return {
        sessionId: 'snapshot-session',
        status: 'awaiting',
        awaiting: { reason: 'approval', source: { approvalId: 'approval-1', toolCallId: 'tool-1' } },
        startedAt: timestamp,
        runningTaskCount: 1,
        completedTaskCount: 0,
        failedTaskCount: 0,
        nativeSidecarStatus: 'mock',
        lastEvent: runStartedEvent(),
    };
}

describe('TUI project/event/sync projections', () => {
    it('initializes project and sync state from runtime paths, ChatStore, and session snapshots', async () => {
        const roots = makeTempProviderRoots();
        const rendered = renderProjectSync(
            makeRuntimeOptions(roots, {
                loadSessionSnapshot: () => awaitingSnapshot(),
            }),
            roots,
        );

        await rendered.sync.ready;

        expect(rendered.project.workspaceRoot).toBe(roots.workspace);
        expect(rendered.project.workspaceName).toBe(basename(roots.workspace));
        expect(rendered.project.gitBranch).toBe('feature/projections');
        expect(rendered.project.sessionID()).toBe('snapshot-session');
        expect(rendered.sync.snapshot()?.status).toBe('awaiting');
        expect(rendered.sync.session().status).toBe('awaiting');
        expect(rendered.sync.awaiting()?.reason).toBe('approval');
        rendered.dispose();
    });

    it('updates provider projections from live events and stops changing after unmount', () => {
        const roots = makeTempProviderRoots();
        const harness = createRuntimeEventHarness();
        const rendered = renderProjectSync(
            makeRuntimeOptions(roots, { subscribeEvents: harness.subscribeEvents }),
            roots,
        );

        expect(harness.subscribeCalls()).toBe(1);

        harness.emit(graphEvent('graph.started', 'graph-live'));
        harness.emit(toolStartedEvent());
        harness.emit(toolCompletedEvent());
        harness.emit(toolCompletedEvent());
        harness.emit(approvalEvent('pending', 'approval.requested'));
        harness.emit(approvalEvent('approved', 'approval.updated'));

        expect(rendered.events.events().map((event) => event.type)).toEqual([
            'graph.started',
            'tool.started',
            'tool.completed',
            'approval.requested',
            'approval.updated',
        ]);
        expect(rendered.events.toolOutcomes()[0]?.status).toBe('completed');
        expect(rendered.events.approvals()[0]?.state).toBe('approved');
        expect(rendered.events.graphSnapshots()[0]?.graphId).toBe('graph-live');

        rendered.dispose();
        harness.emit(graphEvent('graph.completed', 'graph-live'));

        expect(harness.unsubscribeCalls()).toBe(1);
        expect(rendered.events.graphSnapshots()[0]?.status).toBe('active');
    });
});
