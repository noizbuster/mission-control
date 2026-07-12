import {
    type AbgGraphSnapshot,
    type AgentEvent,
    type AgentEventEnvelope,
    AgentEventEnvelopeSchema,
    AgentEventSchema,
    type AgentSnapshot,
} from '@mission-control/protocol';
import type { AbgTimelineEntry } from '../behavior/timeline.js';
import type { LocalLibsqlDb } from '../db/local-libsql-db.js';
import { openMissionControlDb } from '../db/mission-control-db.js';
import { projectSessionReplay, type SessionReplayProjection } from '../session-replay.js';
import type { JsonlSessionEventIdFactory } from './jsonl-session-event-store.js';
import { defaultSession, deriveSession } from './jsonl-session-projection.js';
import type { MemoryStore, SessionCompactionRecordInput } from './memory-store.js';
import { createSessionCompactionEvent } from './session-compaction-event.js';
import { appendParsedSqliteEnvelope, ensureWritableEvent } from './sqlite-session-event-store-append.js';
import { SqliteSessionEventStoreError } from './sqlite-session-event-store-errors.js';
import { readSqliteSessionEnvelopes } from './sqlite-session-event-store-read.js';
import { logFromEvents } from './sqlite-session-event-store-rows.js';
import { ensureSqliteSessionRows, readSqliteNextSequence } from './sqlite-session-event-store-sql.js';
import { runSqliteSessionWriteTransaction } from './sqlite-session-event-store-transaction.js';
import { randomUUID } from 'node:crypto';

export { SqliteSessionEventStoreError };

export type SqliteSessionEventStoreOpenOptions = {
    readonly dataDir?: string;
    readonly sessionId: string;
    readonly now?: () => string;
    readonly createEventId?: JsonlSessionEventIdFactory;
};

export type SqliteSessionEventStoreRuntimeOptions = Omit<SqliteSessionEventStoreOpenOptions, 'dataDir'>;

export class SqliteSessionEventStore implements MemoryStore {
    readonly sessionId: string;
    private readonly runtime: LocalLibsqlDb;
    private readonly now: () => string;
    private readonly createEventId: JsonlSessionEventIdFactory;
    private appendQueue: Promise<void> = Promise.resolve();
    private closed = false;

    private constructor(input: {
        readonly runtime: LocalLibsqlDb;
        readonly sessionId: string;
        readonly now: () => string;
        readonly createEventId: JsonlSessionEventIdFactory;
    }) {
        this.runtime = input.runtime;
        this.sessionId = input.sessionId;
        this.now = input.now;
        this.createEventId = input.createEventId;
    }

    static async open(options: SqliteSessionEventStoreOpenOptions): Promise<SqliteSessionEventStore> {
        const runtime = await openMissionControlDb({
            ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
        });
        return SqliteSessionEventStore.fromRuntime(runtime, options);
    }

    static fromRuntime(
        runtime: LocalLibsqlDb,
        options: SqliteSessionEventStoreRuntimeOptions,
    ): SqliteSessionEventStore {
        return new SqliteSessionEventStore({
            runtime,
            sessionId: options.sessionId,
            now: options.now ?? (() => new Date().toISOString()),
            createEventId: options.createEventId ?? (() => randomUUID()),
        });
    }

    async append(event: AgentEvent): Promise<void> {
        const parsedEvent = AgentEventSchema.parse(event);
        ensureWritableEvent({ sessionId: this.sessionId, event: parsedEvent });
        await this.enqueueAppend(async () => {
            await this.ensureSessionRowsInOpenTransaction(this.now());
            const sequence = await this.readNextSequenceInOpenTransaction();
            const envelope = AgentEventEnvelopeSchema.parse({
                eventId: this.createEventId(parsedEvent, sequence),
                sequence,
                createdAt: this.now(),
                sessionId: this.sessionId,
                durability: 'durable',
                event: parsedEvent,
            });
            await this.appendParsedEnvelopeInOpenTransaction(envelope, sequence);
        });
    }

    async appendEnvelope(envelope: AgentEventEnvelope): Promise<void> {
        const parsedEnvelope = AgentEventEnvelopeSchema.parse(envelope);
        if (parsedEnvelope.durability === 'ephemeral') {
            return;
        }
        await this.enqueueAppend(() =>
            (async () => {
                await this.ensureSessionRowsInOpenTransaction(parsedEnvelope.createdAt);
                const sequence = await this.readNextSequenceInOpenTransaction();
                await this.appendParsedEnvelopeInOpenTransaction(parsedEnvelope, sequence);
            })(),
        );
    }

    async appendEnvelopeWithStoreSequence(envelope: AgentEventEnvelope): Promise<void> {
        const parsedEnvelope = AgentEventEnvelopeSchema.parse(envelope);
        if (parsedEnvelope.durability === 'ephemeral') {
            return;
        }
        await this.enqueueAppend(async () => {
            await this.ensureSessionRowsInOpenTransaction(parsedEnvelope.createdAt);
            const sequence = await this.readNextSequenceInOpenTransaction();
            await this.appendParsedEnvelopeInOpenTransaction({ ...parsedEnvelope, sequence }, sequence);
        });
    }

    async getEvents(sessionId: string): Promise<readonly AgentEvent[]> {
        return (await this.readEnvelopes(sessionId)).map((envelope) => envelope.event);
    }

    async getReplay(sessionId: string): Promise<SessionReplayProjection> {
        return projectSessionReplay({ sessionId, envelopes: await this.readEnvelopes(sessionId) });
    }

    async getSnapshot(sessionId: string): Promise<AgentSnapshot> {
        const events = await this.getEvents(sessionId);
        const log = logFromEvents(events);
        return log.getSnapshot(events.length === 0 ? defaultSession(sessionId) : deriveSession(sessionId, events));
    }

    async getGraphSnapshot(sessionId: string, graphId: string): Promise<AbgGraphSnapshot> {
        return logFromEvents(await this.getEvents(sessionId)).getGraphSnapshot(graphId);
    }

    async getTimeline(sessionId: string): Promise<readonly AbgTimelineEntry[]> {
        return logFromEvents(await this.getEvents(sessionId)).getTimeline();
    }

    async compact(input: SessionCompactionRecordInput): Promise<AgentEvent> {
        const event = createSessionCompactionEvent(input);
        await this.append(event);
        return event;
    }

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        await this.appendQueue;
        this.closed = true;
        this.runtime.close();
    }

    private enqueueAppend(write: () => Promise<void>): Promise<void> {
        const queued = this.appendQueue.then(() => this.withWriteTransaction(write));
        this.appendQueue = queued.catch(() => undefined);
        return queued;
    }

    private async readNextSequenceInOpenTransaction(): Promise<number> {
        return readSqliteNextSequence({ client: this.runtime.client, sessionId: this.sessionId });
    }

    private async appendParsedEnvelopeInOpenTransaction(
        envelope: AgentEventEnvelope,
        expectedSequence: number,
    ): Promise<void> {
        await appendParsedSqliteEnvelope({
            client: this.runtime.client,
            sessionId: this.sessionId,
            envelope,
            expectedSequence,
            now: this.now,
        });
    }

    private async ensureSessionRowsInOpenTransaction(createdAt: string): Promise<void> {
        await ensureSqliteSessionRows({ client: this.runtime.client, sessionId: this.sessionId, createdAt });
    }

    private async readEnvelopes(sessionId: string): Promise<readonly AgentEventEnvelope[]> {
        await this.appendQueue;
        this.ensureOpen();
        return this.readEnvelopesBySessionId(sessionId);
    }

    private async readEnvelopesBySessionId(sessionId: string): Promise<readonly AgentEventEnvelope[]> {
        return readSqliteSessionEnvelopes({ client: this.runtime.client, sessionId });
    }

    private ensureOpen(): void {
        if (this.closed) {
            throw new SqliteSessionEventStoreError({
                code: 'write_failed',
                sessionId: this.sessionId,
                message: `SQLite session store ${this.sessionId} is already closed`,
            });
        }
    }

    private async withWriteTransaction<T>(write: () => Promise<T>): Promise<T> {
        return runSqliteSessionWriteTransaction({ runtime: this.runtime, ensureOpen: () => this.ensureOpen(), write });
    }
}
