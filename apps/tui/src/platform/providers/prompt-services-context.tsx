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
    const ready = reload();

    onCleanup(() => {
        disposed = true;
    });

    async function reload(): Promise<void> {
        const storedEntries = await store.listEntries();
        const parsedEntries = storedEntries.map((entry) => TuiPromptStashEntrySchema.parse(entry));
        if (disposed) return;
        setEntries(parsedEntries);
    }

    async function pushDraft(draft: TuiPromptStashDraft): Promise<TuiPromptStashEntry> {
        const entry = await store.pushEntry(draft);
        await reload();
        return TuiPromptStashEntrySchema.parse(entry);
    }

    async function popDraft(): Promise<TuiPromptStashEntry | undefined> {
        const entry = await store.popEntry();
        await reload();
        return entry === undefined ? undefined : TuiPromptStashEntrySchema.parse(entry);
    }

    async function removeEntry(entryId: string): Promise<void> {
        await store.replaceEntries(entries().filter((entry) => entry.id !== entryId));
        await reload();
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
    const ready = reload();

    onCleanup(() => {
        disposed = true;
    });

    async function reload(): Promise<void> {
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
        chatStore?.setFileFrecencyKeys(parsedScores.map((entry) => entry.record.key));
    }

    async function recordAccess(key: string): Promise<TuiFrecencyRecord> {
        const record = await store.recordAccess(key);
        await reload();
        return TuiFrecencyRecordSchema.parse(record);
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
        chatStore?.setFileFrecencyKeys(frecency.rankedKeys());
    }

    return Object.freeze({ recordFileReference });
}
