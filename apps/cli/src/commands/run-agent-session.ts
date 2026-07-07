import { defaultModelProviderSelection } from '@mission-control/config';
import { type LocalSessionEventStore, openLocalSessionEventStore } from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import { createSessionWorkspaceMetadataEvent, resolveSessionWorkspaceMetadata } from './session-workspace-metadata.js';

export type EnsuredSession = {
    readonly sessionId: string;
    readonly store: LocalSessionEventStore;
};

export type RunEventRecorder = {
    readonly record: (event: AgentEvent) => AgentEvent;
    readonly close: () => Promise<void>;
    readonly currentSessionId: () => string | undefined;
    readonly currentStore: () => LocalSessionEventStore | undefined;
    readonly switchSession: (sessionId: string) => Promise<LocalSessionEventStore>;
    readonly ensureSession: () => Promise<EnsuredSession>;
};

export async function createRunEventRecorder(
    args: CliArgs,
    options: { readonly workspaceRoot?: string } = {},
): Promise<RunEventRecorder> {
    const lazy = args.mode === 'tui' && args.sessionId === undefined;
    const modelProviderSelection: ModelProviderSelection = args.modelProviderSelection ?? defaultModelProviderSelection;
    let currentSessionId: string | undefined;
    let currentStore: LocalSessionEventStore | undefined;
    let metadataRecorded: boolean;
    if (lazy) {
        currentSessionId = undefined;
        currentStore = undefined;
        metadataRecorded = false;
    } else {
        currentSessionId = args.sessionId ?? (createsTransientSessionStore(args) ? createSessionId() : undefined);
        currentStore =
            currentSessionId === undefined
                ? undefined
                : await openLocalSessionEventStore({ sessionId: currentSessionId });
        metadataRecorded =
            currentSessionId === undefined || currentStore === undefined
                ? false
                : await hasWorkspaceMetadata(currentStore, currentSessionId);
    }
    let appendPromises: Promise<void>[] = [];
    const workspaceMetadata =
        options.workspaceRoot === undefined ? undefined : await resolveSessionWorkspaceMetadata(options.workspaceRoot);

    const flushAppends = async (): Promise<void> => {
        const pending = appendPromises;
        appendPromises = [];
        await Promise.all(pending);
    };

    const openSessionStore = async (sessionId: string): Promise<LocalSessionEventStore> => {
        if (currentSessionId === sessionId && currentStore !== undefined) {
            return currentStore;
        }
        await flushAppends();
        await currentStore?.close();
        currentSessionId = sessionId;
        currentStore = await openLocalSessionEventStore({ sessionId });
        metadataRecorded = await hasWorkspaceMetadata(currentStore, sessionId);
        return currentStore;
    };

    // session.started is appended directly (not via record()) because record() short-circuits until materialized.
    const ensureSession = async (): Promise<EnsuredSession> => {
        if (currentSessionId !== undefined && currentStore !== undefined) {
            return { sessionId: currentSessionId, store: currentStore };
        }
        const sessionId = createSessionId();
        const store = await openLocalSessionEventStore({ sessionId });
        currentSessionId = sessionId;
        currentStore = store;
        metadataRecorded = false;
        const startedAt = new Date().toISOString();
        appendPromises.push(
            store.append({
                type: 'session.started',
                timestamp: startedAt,
                sessionId,
                message: 'mission-control session started',
                nativeSidecarStatus: 'mock',
                modelProviderSelection,
            }),
        );
        if (workspaceMetadata !== undefined) {
            metadataRecorded = true;
            appendPromises.push(store.append(createSessionWorkspaceMetadataEvent(sessionId, workspaceMetadata)));
        }
        await flushAppends();
        return { sessionId, store };
    };

    return {
        record: (event) => {
            if (currentSessionId === undefined || currentStore === undefined) {
                return event;
            }
            const mapped = { ...event, sessionId: currentSessionId };
            appendPromises.push(currentStore.append(mapped));
            if (!metadataRecorded && mapped.type === 'session.started' && workspaceMetadata !== undefined) {
                metadataRecorded = true;
                appendPromises.push(
                    currentStore.append(createSessionWorkspaceMetadataEvent(currentSessionId, workspaceMetadata)),
                );
            }
            return mapped;
        },
        close: async () => {
            try {
                await flushAppends();
            } finally {
                await currentStore?.close();
            }
        },
        currentSessionId: () => currentSessionId,
        currentStore: () => currentStore,
        switchSession: openSessionStore,
        ensureSession,
    };
}

async function hasWorkspaceMetadata(store: LocalSessionEventStore, sessionId: string): Promise<boolean> {
    const events = await store.getEvents(sessionId);
    return events.some(
        (event) =>
            event.type === 'session.metadata.updated' &&
            event.sessionTree?.kind === 'metadata' &&
            event.sessionTree.cwd !== undefined,
    );
}

function createsTransientSessionStore(args: CliArgs): boolean {
    return args.mode === 'jsonl' || args.mode === 'tui' || (args.mode === 'json' && args.command === 'run');
}

function createSessionId(): string {
    return `session_${Date.now()}`;
}
