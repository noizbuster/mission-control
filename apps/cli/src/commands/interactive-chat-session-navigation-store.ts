import {
    JsonlSessionEventStore,
    type JsonlSessionReplayPrefixProjection,
    projectJsonlSessionReplayPrefix,
    resolveMissionControlDataDir,
    type JsonlSessionEventStore as SessionStore,
} from '@mission-control/core';
import type { AgentEvent, AgentEventEnvelope, ModelProviderSelection } from '@mission-control/protocol';
import { latestSelection } from './interactive-chat-session-navigation-format.js';
import { createSessionWorkspaceMetadataEvent, resolveSessionWorkspaceMetadata } from './session-workspace-metadata.js';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type SessionNavigationStoreObserver = ((event: AgentEvent) => void) | undefined;

export class SessionNavigationError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SessionNavigationError';
    }
}

export type PreparedTargetSession = {
    readonly sessionId: string;
    readonly selection: ModelProviderSelection;
    readonly store: SessionStore;
};

export async function readSessionNavigationReplay(sessionId: string): Promise<JsonlSessionReplayPrefixProjection> {
    return projectJsonlSessionReplayPrefix({
        sessionId,
        contents: await readFile(join(resolveMissionControlDataDir(), 'sessions', `${sessionId}.jsonl`), 'utf8'),
    });
}

export function assertReplayIsReadable(
    replay: JsonlSessionReplayPrefixProjection,
    sessionId: string,
    action: string,
): void {
    if (replay.diagnostics.length > 0 || replay.projection.sessionTree.diagnostics.length > 0) {
        throw new SessionNavigationError(`Cannot ${action} corrupt session: ${sessionId}`);
    }
}

export async function prepareTargetSession(input: {
    readonly fallbackSelection: ModelProviderSelection;
    readonly replay?: JsonlSessionReplayPrefixProjection;
    readonly requestedSessionId?: string;
    readonly startedMessage: string;
    readonly observeStoredEvent: SessionNavigationStoreObserver;
    readonly workspaceRoot?: string;
}): Promise<PreparedTargetSession> {
    const sessionId = validatedSessionId(input.requestedSessionId ?? generatedSessionId());
    const store = await JsonlSessionEventStore.open({ sessionId });
    const existing = await store.getEvents(sessionId);
    if (existing.length > 0) {
        await store.close();
        throw new SessionNavigationError(`Session already exists: ${sessionId}`);
    }
    const selection =
        input.replay === undefined
            ? input.fallbackSelection
            : (latestSelection(input.replay) ?? input.fallbackSelection);
    await appendStoredEvent(
        store,
        sessionEvent(sessionId, 'session.started', selection, { message: input.startedMessage }),
        input.observeStoredEvent,
    );
    if (input.workspaceRoot !== undefined) {
        await store.append(
            createSessionWorkspaceMetadataEvent(sessionId, await resolveSessionWorkspaceMetadata(input.workspaceRoot)),
        );
    }
    return { sessionId, selection, store };
}

export async function finalizeAndSwitchTargetSession(
    prepared: PreparedTargetSession,
    switchSessionStore: (sessionId: string) => Promise<SessionStore>,
): Promise<SessionStore> {
    await prepared.store.close();
    return switchSessionStore(prepared.sessionId);
}

export async function copyDurableReplayEnvelopes(
    store: SessionStore,
    sessionId: string,
    envelopes: readonly AgentEventEnvelope[],
    observeStoredEvent: SessionNavigationStoreObserver,
): Promise<void> {
    for (const envelope of envelopes) {
        if (!shouldCopyDurableEnvelope(envelope)) {
            continue;
        }
        const copiedEvent = { ...envelope.event, sessionId };
        await store.appendEnvelopeWithStoreSequence({
            ...envelope,
            sessionId,
            event: copiedEvent,
        });
        observeStoredEvent?.(copiedEvent);
    }
}

export async function appendSessionNavigationEvent(
    store: SessionStore,
    event: AgentEvent,
    observeStoredEvent: SessionNavigationStoreObserver,
): Promise<void> {
    await appendStoredEvent(store, event, observeStoredEvent);
}

export function createSessionNavigationEvent(
    sessionId: string,
    type: AgentEvent['type'],
    modelProviderSelection: ModelProviderSelection,
    input: { readonly message: string; readonly sessionTree?: AgentEvent['sessionTree'] },
): AgentEvent {
    return sessionEvent(sessionId, type, modelProviderSelection, input);
}

export function validatedSessionId(sessionId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) {
        throw new SessionNavigationError(`Invalid session id: ${sessionId}`);
    }
    return sessionId;
}

export function requireCurrentSessionId(sessionId: string | undefined): string {
    if (sessionId === undefined) {
        throw new SessionNavigationError('No durable session is active');
    }
    return sessionId;
}

export function requireCurrentStore(store: SessionStore | undefined): SessionStore {
    if (store === undefined) {
        throw new SessionNavigationError('No durable session store is active');
    }
    return store;
}

export function isSessionNavigationError(error: unknown): error is SessionNavigationError {
    return error instanceof SessionNavigationError;
}

function generatedSessionId(): string {
    return `session_${Date.now()}`;
}

async function appendStoredEvent(
    store: SessionStore,
    event: AgentEvent,
    observeStoredEvent: SessionNavigationStoreObserver,
): Promise<void> {
    await store.append(event);
    observeStoredEvent?.(event);
}

function shouldCopyDurableEnvelope(envelope: AgentEventEnvelope): boolean {
    return !isSkippedDurableEventType(envelope.event.type);
}

function isSkippedDurableEventType(type: AgentEvent['type']): boolean {
    return (
        type === 'session.started' ||
        type === 'session.stopped' ||
        type.startsWith('run.') ||
        type.startsWith('approval.') ||
        type.startsWith('permission.') ||
        type.startsWith('tool.')
    );
}

function sessionEvent(
    sessionId: string,
    type: AgentEvent['type'],
    modelProviderSelection: ModelProviderSelection,
    input: { readonly message: string; readonly sessionTree?: AgentEvent['sessionTree'] },
): AgentEvent {
    return {
        type,
        timestamp: new Date().toISOString(),
        sessionId,
        message: input.message,
        nativeSidecarStatus: 'mock',
        modelProviderSelection,
        ...(input.sessionTree !== undefined ? { sessionTree: input.sessionTree } : {}),
    };
}
