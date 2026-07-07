import type { AbgGraphSnapshot, AgentEvent, AgentEventEnvelope, AgentSnapshot } from '@mission-control/protocol';
import type { AbgTimelineEntry } from '../behavior/timeline.js';
import { resolveMissionControlDataDir } from './data-dir.js';
import { type JsonlSessionEventIdFactory, JsonlSessionEventStoreError } from './jsonl-session-event-store.js';
import { ensureLocalSessionDatabase } from './local-session-store-database.js';
import { localSessionDbUrl, parseLocalSessionId } from './local-session-store-paths.js';
import type { MemoryStore, SessionCompactionRecordInput } from './memory-store.js';
import { SqliteSessionEventStore } from './sqlite-session-event-store.js';

export type LocalSessionEventStore = MemoryStore & {
    readonly sessionId: string;
    readonly appendEnvelopeWithStoreSequence: (envelope: AgentEventEnvelope) => Promise<void>;
    readonly close: () => Promise<void> | void;
};

export type OpenLocalSessionEventStoreOptions = {
    readonly dataDir?: string;
    readonly sessionId: string;
    readonly now?: () => string;
    readonly createEventId?: JsonlSessionEventIdFactory;
};

export async function openLocalSessionEventStore(
    options: OpenLocalSessionEventStoreOptions,
): Promise<LocalSessionEventStore> {
    const dataDir = options.dataDir ?? resolveMissionControlDataDir();
    const sessionId = parseLocalSessionId(options.sessionId);
    const now = options.now ?? (() => new Date().toISOString());
    let store: SqliteSessionEventStore | undefined;
    try {
        await ensureLocalSessionDatabase({ dataDir, now });
        store = await SqliteSessionEventStore.open({
            url: localSessionDbUrl(dataDir),
            sessionId,
            now,
            ...(options.createEventId !== undefined ? { createEventId: options.createEventId } : {}),
        });
        return new DatabaseLocalSessionEventStore(store);
    } catch (error: unknown) {
        await store?.close();
        throw error;
    }
}

class DatabaseLocalSessionEventStore implements LocalSessionEventStore {
    readonly sessionId: string;
    private readonly store: SqliteSessionEventStore;
    private closed = false;

    constructor(store: SqliteSessionEventStore) {
        this.store = store;
        this.sessionId = store.sessionId;
    }

    async append(event: AgentEvent): Promise<void> {
        this.ensureOpen();
        await this.store.append(event);
    }

    async appendEnvelope(envelope: AgentEventEnvelope): Promise<void> {
        this.ensureOpen();
        await this.store.appendEnvelope(envelope);
    }

    async appendEnvelopeWithStoreSequence(envelope: AgentEventEnvelope): Promise<void> {
        this.ensureOpen();
        await this.store.appendEnvelopeWithStoreSequence(envelope);
    }

    async getEvents(sessionId: string): Promise<readonly AgentEvent[]> {
        this.ensureOpen();
        return this.store.getEvents(sessionId);
    }

    async getSnapshot(sessionId: string): Promise<AgentSnapshot> {
        this.ensureOpen();
        return this.store.getSnapshot(sessionId);
    }

    async getGraphSnapshot(sessionId: string, graphId: string): Promise<AbgGraphSnapshot> {
        this.ensureOpen();
        return this.store.getGraphSnapshot(sessionId, graphId);
    }

    async getTimeline(sessionId: string): Promise<readonly AbgTimelineEntry[]> {
        this.ensureOpen();
        return this.store.getTimeline(sessionId);
    }

    async compact(input: SessionCompactionRecordInput): Promise<AgentEvent> {
        this.ensureOpen();
        return this.store.compact(input);
    }

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.closed = true;
        await this.store.close();
    }

    private ensureOpen(): void {
        if (this.closed) {
            throw new JsonlSessionEventStoreError({
                code: 'write_failed',
                message: `Local session store ${this.sessionId} is already closed`,
                sessionId: this.sessionId,
            });
        }
    }
}
