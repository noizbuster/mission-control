import type { AgentEvent, AgentSnapshot } from '@mission-control/protocol';
import { createRoot, type JSX } from 'solid-js';
import { createComponent } from 'solid-js/web';
import { describe, expect, it } from 'vitest';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types';
import {
    composeMissionControlProviderTree,
    type MissionControlTuiProviderEnvironment,
    type TuiKeymapProviderComponent,
    useTuiRuntimeEvents,
} from './index';
import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

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
};

type RenderedRuntimeEvents = {
    readonly runtimeEvents: ReturnType<typeof useTuiRuntimeEvents>;
    readonly dispose: () => void;
};

const timestamp = '2026-01-01T00:00:00.000Z';

function makeTempProviderRoots(): TempProviderRoots {
    const base = mkdtempSync(join(tmpdir(), 'mctrl-tui-runtime-events-'));
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

function createRuntimeEventHarness(): RuntimeEventHarness & {
    readonly subscribeEvents: NonNullable<ChatTuiRuntimeOptions['subscribeEvents']>;
} {
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
        sessionID: 'runtime-events-session',
        workspaceRoot: roots.workspace,
        ...overrides,
    };
}

function renderRuntimeEvents(options: ChatTuiRuntimeOptions, roots: TempProviderRoots): RenderedRuntimeEvents {
    const renderer: TestRenderer = {
        id: 'renderer',
        copyToClipboardOSC52: () => true,
        isOsc52Supported: () => true,
    };
    const keymapProvider: TuiKeymapProviderComponent<TestRenderer> = (props) => props.children;
    let observed: ReturnType<typeof useTuiRuntimeEvents> | undefined;
    let disposeRoot = (): void => {};

    function Consumer(): JSX.Element {
        observed = useTuiRuntimeEvents();
        return null;
    }

    createRoot((dispose) => {
        disposeRoot = dispose;
        composeMissionControlProviderTree({
            useRenderer: () => renderer,
            keymapProvider,
            runtimeOptions: options,
            environment: makeProviderEnvironment(roots),
            get children() {
                return createComponent(Consumer, {});
            },
        });
    });

    if (observed === undefined) {
        throw new Error('runtime event provider consumer did not render');
    }
    return { runtimeEvents: observed, dispose: disposeRoot };
}

function runEvent(type: 'run.started' | 'run.completed'): AgentEvent {
    return { type, timestamp };
}

function graphEvent(type: 'graph.started' | 'graph.completed'): AgentEvent {
    return { type, timestamp, abg: { graphId: 'graph-1' } };
}

function sessionSnapshot(): AgentSnapshot {
    return {
        sessionId: 'runtime-events-session',
        status: 'running',
        startedAt: timestamp,
        runningTaskCount: 1,
        completedTaskCount: 0,
        failedTaskCount: 0,
        nativeSidecarStatus: 'mock',
        lastEvent: runEvent('run.started'),
    };
}

describe('TUI runtime events provider', () => {
    it('subscribes on mount, projects live AgentEvents, and unsubscribes on dispose', () => {
        const roots = makeTempProviderRoots();
        const harness = createRuntimeEventHarness();
        const rendered = renderRuntimeEvents(
            makeRuntimeOptions(roots, { subscribeEvents: harness.subscribeEvents }),
            roots,
        );

        expect(harness.subscribeCalls()).toBe(1);

        harness.emit(runEvent('run.started'));
        harness.emit(graphEvent('graph.started'));

        expect(rendered.runtimeEvents.events().map((event) => event.type)).toEqual(['run.started', 'graph.started']);
        expect(rendered.runtimeEvents.latestEvent()?.type).toBe('graph.started');
        expect(rendered.runtimeEvents.abgStore.getSnapshot().runState).toBe('running');
        expect(rendered.runtimeEvents.abgStore.getSnapshot().activeGraphId).toBe('graph-1');

        rendered.dispose();
        harness.emit(graphEvent('graph.completed'));

        expect(harness.unsubscribeCalls()).toBe(1);
        expect(rendered.runtimeEvents.events().map((event) => event.type)).toEqual(['run.started', 'graph.started']);
    });

    it('loads the structural session snapshot without receiving the runtime object', async () => {
        const roots = makeTempProviderRoots();
        const rendered = renderRuntimeEvents(
            makeRuntimeOptions(roots, {
                loadSessionSnapshot: () => sessionSnapshot(),
            }),
            roots,
        );

        await rendered.runtimeEvents.ready;

        expect(rendered.runtimeEvents.snapshot()?.sessionId).toBe('runtime-events-session');
        expect(rendered.runtimeEvents.snapshot()?.status).toBe('running');
        expect(Object.keys(rendered.runtimeEvents).sort()).toEqual([
            'abgStore',
            'events',
            'latestEvent',
            'ready',
            'reloadSnapshot',
            'snapshot',
        ]);

        rendered.dispose();
    });
});
