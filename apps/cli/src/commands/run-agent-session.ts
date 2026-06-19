import { JsonlSessionEventStore } from '@mission-control/core';
import type { AgentEvent } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import { createSessionWorkspaceMetadataEvent, resolveSessionWorkspaceMetadata } from './session-workspace-metadata.js';

export type RunEventRecorder = {
    readonly record: (event: AgentEvent) => AgentEvent;
    readonly close: () => Promise<void>;
    readonly currentSessionId: () => string | undefined;
    readonly currentStore: () => JsonlSessionEventStore | undefined;
    readonly switchSession: (sessionId: string) => Promise<JsonlSessionEventStore>;
};

export async function createRunEventRecorder(
    args: CliArgs,
    options: { readonly workspaceRoot?: string } = {},
): Promise<RunEventRecorder> {
    let currentSessionId = args.sessionId ?? (createsTransientSessionStore(args) ? createSessionId() : undefined);
    let currentStore =
        currentSessionId === undefined ? undefined : await JsonlSessionEventStore.open({ sessionId: currentSessionId });
    let metadataRecorded =
        currentSessionId === undefined || currentStore === undefined
            ? false
            : await hasWorkspaceMetadata(currentStore, currentSessionId);
    let appendPromises: Promise<void>[] = [];
    const workspaceMetadata =
        options.workspaceRoot === undefined ? undefined : await resolveSessionWorkspaceMetadata(options.workspaceRoot);

    const flushAppends = async (): Promise<void> => {
        const pending = appendPromises;
        appendPromises = [];
        await Promise.all(pending);
    };

    const openSessionStore = async (sessionId: string): Promise<JsonlSessionEventStore> => {
        if (currentSessionId === sessionId && currentStore !== undefined) {
            return currentStore;
        }
        await flushAppends();
        await currentStore?.close();
        currentSessionId = sessionId;
        currentStore = await JsonlSessionEventStore.open({ sessionId });
        metadataRecorded = await hasWorkspaceMetadata(currentStore, sessionId);
        return currentStore;
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
    };
}

async function hasWorkspaceMetadata(store: JsonlSessionEventStore, sessionId: string): Promise<boolean> {
    const events = await store.getEvents(sessionId);
    return events.some(
        (event) =>
            event.type === 'session.metadata.updated' &&
            event.sessionTree?.kind === 'metadata' &&
            event.sessionTree.cwd !== undefined,
    );
}

function createsTransientSessionStore(args: CliArgs): boolean {
    return args.mode === 'jsonl' || args.mode === 'ink' || (args.mode === 'json' && args.command === 'run');
}

function createSessionId(): string {
    return `session_${Date.now()}`;
}
