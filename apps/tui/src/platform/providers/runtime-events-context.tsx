/** @jsxImportSource @opentui/solid */

import { type AbgOverlayStore, createAbgOverlayStore, projectAgentEvent } from '@mission-control/core';
import { type AgentEvent, type AgentSnapshot, AgentSnapshotSchema } from '@mission-control/protocol';
import { type Accessor, createSignal, type JSX, onCleanup } from 'solid-js';
import type { ChatTuiRuntimeOptions } from '../../state/chat-tui-types.js';
import { createRequiredContext } from './context-base.js';

export type TuiRuntimeEventsService = {
    readonly events: Accessor<readonly AgentEvent[]>;
    readonly latestEvent: Accessor<AgentEvent | undefined>;
    readonly snapshot: Accessor<AgentSnapshot | undefined>;
    readonly abgStore: AbgOverlayStore;
    readonly ready: Promise<void>;
    readonly reloadSnapshot: () => Promise<void>;
};

export type MissionControlRuntimeEventsProviderProps = {
    readonly runtimeOptions: ChatTuiRuntimeOptions;
    readonly children: JSX.Element;
};

const TuiRuntimeEventsContext = createRequiredContext<TuiRuntimeEventsService>('TuiRuntimeEvents');

export function useTuiRuntimeEvents(): TuiRuntimeEventsService {
    return TuiRuntimeEventsContext.useValue();
}

export function MissionControlRuntimeEventsProvider(props: MissionControlRuntimeEventsProviderProps): JSX.Element {
    const service = createTuiRuntimeEventsService(props.runtimeOptions);
    return <TuiRuntimeEventsContext.Provider value={service}>{props.children}</TuiRuntimeEventsContext.Provider>;
}

function createTuiRuntimeEventsService(options: ChatTuiRuntimeOptions): TuiRuntimeEventsService {
    const [events, setEvents] = createSignal<readonly AgentEvent[]>([]);
    const [snapshot, setSnapshot] = createSignal<AgentSnapshot | undefined>();
    const abgStore = createAbgOverlayStore();
    let disposed = false;

    const unsubscribe = options.subscribeEvents?.((event) => {
        if (disposed) return;
        setEvents((current) => [...current, event]);
        abgStore.update((draft) => {
            Object.assign(draft, projectAgentEvent(draft, event));
        });
    });

    const ready = reloadSnapshot();

    onCleanup(() => {
        disposed = true;
        unsubscribe?.();
    });

    async function reloadSnapshot(): Promise<void> {
        const loadedSnapshot = await options.loadSessionSnapshot?.();
        if (disposed || loadedSnapshot === undefined) return;
        setSnapshot(AgentSnapshotSchema.parse(loadedSnapshot));
    }

    return Object.freeze({
        events,
        latestEvent: () => events().at(-1),
        snapshot,
        abgStore,
        ready,
        reloadSnapshot,
    });
}
