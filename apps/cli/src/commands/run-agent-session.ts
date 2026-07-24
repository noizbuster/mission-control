import { defaultModelProviderSelection } from '@mission-control/config';
import {
    createObservabilityRedactor,
    type LocalSessionEventStore,
    type ObservabilityRedactor,
    openLocalSessionEventStore,
    redactAgentEventForObservability,
} from '@mission-control/core';
import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import type { CliArgs } from '../args';
import { createSessionWorkspaceMetadataEvent, resolveSessionWorkspaceMetadata } from './session-workspace-metadata';

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
    readonly shouldFinalizeCurrentSession: () => boolean;
};

export async function createRunEventRecorder(
    args: CliArgs,
    options: { readonly workspaceRoot?: string; readonly observabilityRedactor?: ObservabilityRedactor } = {},
): Promise<RunEventRecorder> {
    const lazy = args.mode === 'tui' && args.sessionId === undefined;
    const modelProviderSelection: ModelProviderSelection = args.modelProviderSelection ?? defaultModelProviderSelection;
    const observabilityRedactor = options.observabilityRedactor ?? createObservabilityRedactor();
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
                : await openLocalSessionEventStore({ sessionId: currentSessionId, observabilityRedactor });
        metadataRecorded =
            currentSessionId === undefined || currentStore === undefined
                ? false
                : await hasWorkspaceMetadata(currentStore, currentSessionId);
    }
    let currentSessionWasAttached = false;
    let recordedSessionWorkSinceAttach = false;
    if (currentSessionId !== undefined && currentStore !== undefined) {
        currentSessionWasAttached = (await currentStore.getEvents(currentSessionId)).length > 0;
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
        const nextStore = await openLocalSessionEventStore({ sessionId, observabilityRedactor });
        currentSessionWasAttached = (await nextStore.getEvents(sessionId)).length > 0;
        recordedSessionWorkSinceAttach = false;
        currentSessionId = sessionId;
        currentStore = nextStore;
        metadataRecorded = await hasWorkspaceMetadata(nextStore, sessionId);
        return nextStore;
    };

    // session.started is appended directly (not via record()) because record() short-circuits until materialized.
    const ensureSession = async (): Promise<EnsuredSession> => {
        if (currentSessionId !== undefined && currentStore !== undefined) {
            return { sessionId: currentSessionId, store: currentStore };
        }
        const sessionId = createSessionId();
        const store = await openLocalSessionEventStore({ sessionId, observabilityRedactor });
        currentSessionId = sessionId;
        currentStore = store;
        currentSessionWasAttached = false;
        recordedSessionWorkSinceAttach = false;
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
            const mapped = redactAgentEventForObservability(
                { ...event, sessionId: currentSessionId },
                observabilityRedactor,
            );
            const preserveAttachedTerminalLifecycle =
                currentSessionWasAttached && !recordedSessionWorkSinceAttach && isAttachLifecycleEvent(mapped.type);
            if (preserveAttachedTerminalLifecycle) {
                return mapped;
            }
            if (!isAttachLifecycleEvent(mapped.type)) {
                recordedSessionWorkSinceAttach = true;
            }
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
        shouldFinalizeCurrentSession: () => !currentSessionWasAttached || recordedSessionWorkSinceAttach,
    };
}
function isAttachLifecycleEvent(type: AgentEvent['type']): boolean {
    return type === 'session.started' || type === 'session.stopped' || type === 'session.finalize';
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
