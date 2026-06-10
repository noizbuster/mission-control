import type { AgentEvent } from '@mission-control/protocol';
import { JsonlSessionEventStore } from '../memory/jsonl-session-event-store.js';
import type { ProviderAdapter, ProviderTurnRequest } from '../providers/provider-turn-types.js';
import { type RunCoordinatorStore, SessionRunCoordinator } from './run-coordinator.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

export type CoordinatorContext = {
    readonly sessionId: string;
    readonly dataDir: string;
    readonly store: JsonlSessionEventStore;
    readonly createCoordinator: (provider: ProviderAdapter) => SessionRunCoordinator;
    readonly createCoordinatorWithStore: (
        store: RunCoordinatorStore,
        provider: ProviderAdapter,
    ) => SessionRunCoordinator;
    readonly events: () => Promise<readonly AgentEvent[]>;
};

export async function cleanupCoordinatorContexts(): Promise<void> {
    for (const tempDir of tempDirs.splice(0)) {
        await rm(tempDir, { recursive: true, force: true });
    }
}

export async function openCoordinatorContext(sessionId: string): Promise<CoordinatorContext> {
    const dataDir = await mkdtemp(join(tmpdir(), 'mission-control-run-coordinator-'));
    tempDirs.push(dataDir);
    return openCoordinatorContextAt(sessionId, dataDir);
}

export async function reopenCoordinatorContext(context: CoordinatorContext): Promise<CoordinatorContext> {
    return openCoordinatorContextAt(context.sessionId, context.dataDir);
}

export function providerFromRequests(
    onRequest: (request: ProviderTurnRequest, index: number) => Promise<void>,
): ProviderAdapter {
    let index = 0;
    return {
        async *streamTurn(request) {
            const currentIndex = index;
            index += 1;
            await onRequest(request, currentIndex);
            yield {
                kind: 'response_completed',
                requestId: request.requestId,
                sequence: 1,
                message: { messageId: `assistant_${currentIndex}`, role: 'assistant', content: 'done' },
                finishReason: 'stop',
            };
        },
    };
}

export function deferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
    let resolve: (value: T) => void = () => undefined;
    const promise = new Promise<T>((innerResolve) => {
        resolve = innerResolve;
    });
    return { promise, resolve };
}

export function delaySecondAdmissionStore(
    store: RunCoordinatorStore,
    admissionBlocked: ReturnType<typeof deferred<void>>,
    holdAdmission: ReturnType<typeof deferred<void>>,
): RunCoordinatorStore {
    return delayAdmissionStore(store, 'input_second', admissionBlocked, holdAdmission);
}

export function delayAdmissionStore(
    store: RunCoordinatorStore,
    inputId: string,
    admissionBlocked: ReturnType<typeof deferred<void>>,
    holdAdmission: ReturnType<typeof deferred<void>>,
): RunCoordinatorStore {
    return {
        append: async (event: AgentEvent) => {
            if (event.type === 'prompt.admitted' && event.transcript?.inputId === inputId) {
                admissionBlocked.resolve();
                await holdAdmission.promise;
            }
            await store.append(event);
        },
        getEvents: (sessionId) => store.getEvents(sessionId),
    };
}

async function openCoordinatorContextAt(sessionId: string, dataDir: string): Promise<CoordinatorContext> {
    const store = await JsonlSessionEventStore.open({
        sessionId,
        dataDir,
        now: fixedNow,
        createEventId: (_event, sequence) => `event_${sequence}`,
    });
    return {
        sessionId,
        dataDir,
        store,
        createCoordinator(provider) {
            return createCoordinator({ sessionId, store, provider });
        },
        createCoordinatorWithStore(customStore, provider) {
            return createCoordinator({ sessionId, store: customStore, provider });
        },
        events: () => store.getEvents(sessionId),
    };
}

function createCoordinator(input: {
    readonly sessionId: string;
    readonly store: RunCoordinatorStore;
    readonly provider: ProviderAdapter;
}): SessionRunCoordinator {
    return new SessionRunCoordinator({
        sessionId: input.sessionId,
        store: input.store,
        provider: input.provider,
        modelProviderSelection: { providerID: 'local', modelID: 'deterministic' },
        now: fixedNow,
        timeoutMs: 50,
        createId: (prefix, index) => `${prefix}_${index}`,
    });
}

function fixedNow(): string {
    return '2026-06-09T10:00:00.000Z';
}
