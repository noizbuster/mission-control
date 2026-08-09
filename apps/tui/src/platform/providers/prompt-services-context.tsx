/** @jsxImportSource @opentui/solid */

import { TuiStores } from '@mission-control/core';
import {
    type TuiFrecencyRecord,
    TuiFrecencyRecordSchema,
    type TuiPromptStashEntry,
    TuiPromptStashEntrySchema,
} from '@mission-control/protocol';
import { type Accessor, createSignal, type JSX, onCleanup } from 'solid-js';
import type { ChatStore } from '../../state/chat-store';
import { createRequiredContext } from './context-base';
import { useTuiPaths } from './runtime-context';

export type TuiPromptStashStoreLike = {
    readonly listEntries: () => Promise<readonly TuiPromptStashEntry[]>;
    readonly pushEntry: (entry: TuiPromptStashDraft) => Promise<TuiPromptStashEntry>;
    readonly popEntry: () => Promise<TuiPromptStashEntry | undefined>;
    readonly replaceEntries: (entries: readonly TuiPromptStashEntry[]) => Promise<void>;
};

export type TuiFrecencyScoreEntry = {
    readonly record: TuiFrecencyRecord;
    readonly score: number;
};

export type TuiFrecencyStoreLike = {
    readonly listRecords: () => Promise<readonly TuiFrecencyRecord[]>;
    readonly listByScore: () => Promise<readonly TuiFrecencyScoreEntry[]>;
    readonly recordAccess: (key: string) => Promise<TuiFrecencyRecord>;
};

export type TuiPromptStashDraft = {
    readonly text: string;
    readonly cursorOffset: number;
};

export type TuiPromptStashService = {
    readonly entries: Accessor<readonly TuiPromptStashEntry[]>;
    readonly ready: Promise<void>;
    readonly reload: () => Promise<void>;
    readonly pushDraft: (draft: TuiPromptStashDraft) => Promise<TuiPromptStashEntry>;
    readonly popDraft: () => Promise<TuiPromptStashEntry | undefined>;
    readonly removeEntry: (entryId: string) => Promise<void>;
};

export type TuiFrecencyService = {
    readonly records: Accessor<readonly TuiFrecencyRecord[]>;
    readonly scored: Accessor<readonly TuiFrecencyScoreEntry[]>;
    readonly rankedKeys: Accessor<readonly string[]>;
    readonly ready: Promise<void>;
    readonly reload: () => Promise<void>;
    readonly recordAccess: (key: string) => Promise<TuiFrecencyRecord>;
};

export type TuiPromptRefService = {
    readonly recordFileReference: (path: string) => Promise<void>;
};

export type MissionControlPromptServicesProviderProps = {
    readonly chatStore?: ChatStore;
    readonly promptStashStore?: TuiPromptStashStoreLike;
    readonly frecencyStore?: TuiFrecencyStoreLike;
    readonly children: JSX.Element;
};

const TuiPromptStashContext = createRequiredContext<TuiPromptStashService>('TuiPromptStash');
const TuiFrecencyContext = createRequiredContext<TuiFrecencyService>('TuiFrecency');
const TuiPromptRefContext = createRequiredContext<TuiPromptRefService>('TuiPromptRef');

export function useTuiPromptStash(): TuiPromptStashService {
    return TuiPromptStashContext.useValue();
}

export function useTuiFrecency(): TuiFrecencyService {
    return TuiFrecencyContext.useValue();
}

export function useTuiPromptRef(): TuiPromptRefService {
    return TuiPromptRefContext.useValue();
}

export function MissionControlPromptServicesProvider(props: MissionControlPromptServicesProviderProps): JSX.Element {
    const paths = useTuiPaths();
    const promptStashStore = props.promptStashStore ?? new TuiStores.TuiPromptStashStore({ dataDir: paths.dataDir });
    const frecencyStore = props.frecencyStore ?? new TuiStores.TuiFrecencyStore({ dataDir: paths.dataDir });
    const promptStash = createTuiPromptStashService(promptStashStore);
    const frecency = createTuiFrecencyService(frecencyStore, props.chatStore);
    const promptRef = createTuiPromptRefService(frecency, props.chatStore);

    return (
        <TuiPromptStashContext.Provider value={promptStash}>
            <TuiFrecencyContext.Provider value={frecency}>
                <TuiPromptRefContext.Provider value={promptRef}>{props.children}</TuiPromptRefContext.Provider>
            </TuiFrecencyContext.Provider>
        </TuiPromptStashContext.Provider>
    );
}

function createTuiPromptStashService(store: TuiPromptStashStoreLike): TuiPromptStashService {
    const [entries, setEntries] = createSignal<readonly TuiPromptStashEntry[]>([]);
    let disposed = false;
    // Serialize service-level reload/mutate so in-memory apply cannot clobber store pushes.
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
        const storedEntries = await store.listEntries();
        const parsedEntries = storedEntries.map((entry) => TuiPromptStashEntrySchema.parse(entry));
        if (disposed) return;
        setEntries(parsedEntries);
    }

    async function reload(): Promise<void> {
        await enqueue(async () => {
            await reloadFromStore();
        });
    }

    const ready = reload();

    async function pushDraft(draft: TuiPromptStashDraft): Promise<TuiPromptStashEntry> {
        return enqueue(async () => {
            const entry = await store.pushEntry(draft);
            await reloadFromStore();
            return TuiPromptStashEntrySchema.parse(entry);
        });
    }

    async function popDraft(): Promise<TuiPromptStashEntry | undefined> {
        return enqueue(async () => {
            const entry = await store.popEntry();
            await reloadFromStore();
            return entry === undefined ? undefined : TuiPromptStashEntrySchema.parse(entry);
        });
    }

    async function removeEntry(entryId: string): Promise<void> {
        await enqueue(async () => {
            // Read disk-backed list inside the chain — never filter a stale signal snapshot.
            const current = await store.listEntries();
            await store.replaceEntries(current.filter((entry) => entry.id !== entryId));
            await reloadFromStore();
        });
    }

    return Object.freeze({
        entries,
        ready,
        reload,
        pushDraft,
        popDraft,
        removeEntry,
    });
}

function createTuiFrecencyService(store: TuiFrecencyStoreLike, chatStore: ChatStore | undefined): TuiFrecencyService {
    const [records, setRecords] = createSignal<readonly TuiFrecencyRecord[]>([]);
    const [scored, setScored] = createSignal<readonly TuiFrecencyScoreEntry[]>([]);
    const rankedKeys = (): readonly string[] => scored().map((entry) => entry.record.key);
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
        const storedRecords = await store.listRecords();
        const rankedRecords = await store.listByScore();
        const parsedRecords = storedRecords.map((record) => TuiFrecencyRecordSchema.parse(record));
        const parsedScores = rankedRecords.map((entry) => ({
            record: TuiFrecencyRecordSchema.parse(entry.record),
            score: entry.score,
        }));
        if (disposed) return;
        setRecords(parsedRecords);
        setScored(parsedScores);
        if (chatStore?.isEventQueueClosed() === true) return;
        chatStore?.setFileFrecencyKeys(parsedScores.map((entry) => entry.record.key));
    }

    async function reload(): Promise<void> {
        await enqueue(async () => {
            await reloadFromStore();
        });
    }

    const ready = reload();

    async function recordAccess(key: string): Promise<TuiFrecencyRecord> {
        return enqueue(async () => {
            const record = await store.recordAccess(key);
            await reloadFromStore();
            return TuiFrecencyRecordSchema.parse(record);
        });
    }

    return Object.freeze({
        records,
        scored,
        rankedKeys,
        ready,
        reload,
        recordAccess,
    });
}

function createTuiPromptRefService(
    frecency: TuiFrecencyService,
    chatStore: ChatStore | undefined,
): TuiPromptRefService {
    async function recordFileReference(path: string): Promise<void> {
        await frecency.recordAccess(path);
        // recordAccess already reloads + mirrors keys when live; re-read only if still mounted.
        if (chatStore?.isEventQueueClosed() === true) return;
        chatStore?.setFileFrecencyKeys(frecency.rankedKeys());
    }

    return Object.freeze({ recordFileReference });
}
