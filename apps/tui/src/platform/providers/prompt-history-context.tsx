/** @jsxImportSource @opentui/solid */

import { TuiStores } from '@mission-control/core';
import { type TuiPromptHistoryEntry, TuiPromptHistoryEntrySchema } from '@mission-control/protocol';
import { type Accessor, createSignal, type JSX, onCleanup } from 'solid-js';
import type { ChatStore } from '../../state/chat-store';
import { createRequiredContext } from './context-base';
import { useTuiPaths } from './runtime-context';

export type TuiPromptHistoryStoreLike = {
    readonly listEntries: () => Promise<readonly TuiPromptHistoryEntry[]>;
    readonly listTexts: () => Promise<readonly string[]>;
    readonly appendText: (text: string) => Promise<TuiPromptHistoryEntry | undefined>;
};

export type TuiPromptHistoryService = {
    readonly entries: Accessor<readonly TuiPromptHistoryEntry[]>;
    readonly texts: Accessor<readonly string[]>;
    readonly ready: Promise<void>;
    readonly reload: () => Promise<void>;
    readonly appendPrompt: (text: string) => Promise<void>;
};

export type MissionControlPromptHistoryProviderProps = {
    readonly chatStore?: ChatStore;
    readonly promptHistoryStore?: TuiPromptHistoryStoreLike;
    readonly children: JSX.Element;
};

const TuiPromptHistoryContext = createRequiredContext<TuiPromptHistoryService>('TuiPromptHistory');

export function useTuiPromptHistory(): TuiPromptHistoryService {
    return TuiPromptHistoryContext.useValue();
}

export function MissionControlPromptHistoryProvider(props: MissionControlPromptHistoryProviderProps): JSX.Element {
    const paths = useTuiPaths();
    const store = props.promptHistoryStore ?? new TuiStores.TuiPromptHistoryStore({ dataDir: paths.dataDir });
    const service = createTuiPromptHistoryService(store, props.chatStore);

    return <TuiPromptHistoryContext.Provider value={service}>{props.children}</TuiPromptHistoryContext.Provider>;
}

function createTuiPromptHistoryService(
    store: TuiPromptHistoryStoreLike,
    chatStore: ChatStore | undefined,
): TuiPromptHistoryService {
    const [entries, setEntries] = createSignal<readonly TuiPromptHistoryEntry[]>([]);
    const texts = (): readonly string[] => entries().map((entry) => entry.text);
    let disposed = false;
    let opChain: Promise<void> = Promise.resolve();

    function enqueue<T>(task: () => Promise<T>): Promise<T> {
        const run = opChain.then(task, task);
        opChain = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }

    onCleanup(() => {
        disposed = true;
    });

    async function reloadFromStore(): Promise<void> {
        const historyGen = chatStore?.beginHistoryEntriesReseed() ?? 0;
        const storedEntries = await store.listEntries();
        const parsedEntries = storedEntries.map((entry) => TuiPromptHistoryEntrySchema.parse(entry));
        if (disposed) return;
        setEntries(parsedEntries);
        if (chatStore === undefined || chatStore.isEventQueueClosed()) return;
        // Boot reload can finish after submitLine already appended live recall entries.
        if (!chatStore.shouldApplyHistoryEntriesReseed(historyGen)) return;
        // Never shrink/replace a longer live history with a stale disk snapshot.
        const liveCount = chatStore.getSnapshot().historyEntries.length;
        if (liveCount > parsedEntries.length) return;
        chatStore.setHistoryEntries(parsedEntries);
    }

    async function reload(): Promise<void> {
        await enqueue(async () => {
            await reloadFromStore();
        });
    }

    const ready = reload();

    async function appendPrompt(text: string): Promise<void> {
        await enqueue(async () => {
            await store.appendText(text);
            await reloadFromStore();
        });
    }

    return Object.freeze({
        entries,
        texts,
        ready,
        reload,
        appendPrompt,
    });
}

