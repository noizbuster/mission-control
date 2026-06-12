import {
    type AbgGraphSnapshot,
    type AgentEvent,
    type AgentEventEnvelope,
    AgentEventEnvelopeSchema,
    AgentEventSchema,
    type AgentSnapshot,
} from '@mission-control/protocol';
import type { AbgTimelineEntry } from '../behavior/timeline.js';
import { SessionEventLog } from '../session-log.js';
import { jsonlStoreError } from './jsonl-errors.js';
import { sessionMismatch } from './jsonl-session-event-errors.js';
import {
    type OpenedJsonlSessionFile,
    type OpenJsonlSessionFileOptions,
    openJsonlSessionFile,
    releaseSessionLock,
} from './jsonl-session-files.js';
import {
    DEFAULT_JSONL_SESSION_LOCK_STALE_AFTER_MS,
    heartbeatJsonlSessionLock,
    type JsonlSessionLockLease,
} from './jsonl-session-lock.js';
import { defaultSession, deriveSession } from './jsonl-session-projection.js';
import { createJsonlSessionEventRecord, serializeJsonlRecord } from './jsonl-session-records.js';
import type { MemoryStore } from './memory-store.js';
import { randomUUID } from 'node:crypto';

export { JsonlSessionEventStoreError } from './jsonl-errors.js';

export type JsonlSessionEventIdFactory = (event: AgentEvent, sequence: number) => string;

export type JsonlSessionEventStoreOpenOptions = Omit<OpenJsonlSessionFileOptions, 'now'> & {
    readonly now?: () => string;
    readonly createEventId?: JsonlSessionEventIdFactory;
    readonly lockHeartbeatIntervalMs?: number;
};

type JsonlSessionEventStoreInput = OpenedJsonlSessionFile & {
    readonly now: () => string;
    readonly createEventId: JsonlSessionEventIdFactory;
    readonly lockHeartbeatIntervalMs: number;
};

export class JsonlSessionEventStore implements MemoryStore {
    readonly sessionId: string;
    readonly filePath: string;
    readonly lockPath: string;
    private readonly fileHandle: OpenedJsonlSessionFile['fileHandle'];
    private readonly log: SessionEventLog;
    private readonly now: () => string;
    private readonly createEventId: JsonlSessionEventIdFactory;
    private lockHandle: OpenedJsonlSessionFile['lockHandle'];
    private lockLease: JsonlSessionLockLease;
    private nextSequence: number;
    private appendQueue: Promise<void> = Promise.resolve();
    private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    private heartbeatFailure: unknown;
    private closed = false;

    private constructor(input: JsonlSessionEventStoreInput) {
        this.sessionId = input.sessionId;
        this.filePath = input.filePath;
        this.lockPath = input.lockPath;
        this.fileHandle = input.fileHandle;
        this.lockHandle = input.lockHandle;
        this.log = input.log;
        this.now = input.now;
        this.createEventId = input.createEventId;
        this.lockLease = input.lockLease;
        this.nextSequence = input.nextSequence;
        this.startHeartbeat(input.lockHeartbeatIntervalMs);
    }

    static async open(options: JsonlSessionEventStoreOpenOptions): Promise<JsonlSessionEventStore> {
        const now = options.now ?? (() => new Date().toISOString());
        const createEventId = options.createEventId ?? (() => randomUUID());
        const openedFile = await openJsonlSessionFile({ ...options, now });
        const staleAfterMs = options.lockStaleAfterMs ?? DEFAULT_JSONL_SESSION_LOCK_STALE_AFTER_MS;
        const lockHeartbeatIntervalMs = options.lockHeartbeatIntervalMs ?? Math.max(1_000, staleAfterMs / 3);

        return new JsonlSessionEventStore({
            ...openedFile,
            now,
            createEventId,
            lockHeartbeatIntervalMs,
        });
    }

    async append(event: AgentEvent): Promise<void> {
        const parsedEvent = AgentEventSchema.parse(event);
        this.ensureWritableEvent(parsedEvent);
        await this.enqueueAppend(async () => {
            const sequence = this.nextSequence;
            const envelope = AgentEventEnvelopeSchema.parse({
                eventId: this.createEventId(parsedEvent, sequence),
                sequence,
                createdAt: this.now(),
                sessionId: this.sessionId,
                durability: 'durable',
                event: parsedEvent,
            });
            await this.appendParsedEnvelope(envelope);
        });
    }

    async appendEnvelope(envelope: AgentEventEnvelope): Promise<void> {
        const parsedEnvelope = AgentEventEnvelopeSchema.parse(envelope);
        if (parsedEnvelope.durability === 'ephemeral') {
            return;
        }
        await this.enqueueAppend(() => this.appendParsedEnvelope(parsedEnvelope));
    }

    async appendEnvelopeWithStoreSequence(envelope: AgentEventEnvelope): Promise<void> {
        const parsedEnvelope = AgentEventEnvelopeSchema.parse(envelope);
        if (parsedEnvelope.durability === 'ephemeral') {
            return;
        }
        await this.enqueueAppend(() =>
            this.appendParsedEnvelope(
                AgentEventEnvelopeSchema.parse({
                    ...parsedEnvelope,
                    sequence: this.nextSequence,
                }),
            ),
        );
    }

    private async appendParsedEnvelope(envelope: AgentEventEnvelope): Promise<void> {
        this.ensureWritableEnvelope(envelope);
        await this.refreshLockLease();
        await this.writeRecord(createJsonlSessionEventRecord(envelope));
        this.log.append(envelope.event);
        this.nextSequence = envelope.sequence + 1;
    }

    private enqueueAppend(write: () => Promise<void>): Promise<void> {
        const queued = this.appendQueue.then(write);
        this.appendQueue = queued.catch(() => undefined);
        return queued;
    }

    async getEvents(sessionId: string): Promise<readonly AgentEvent[]> {
        if (sessionId !== this.sessionId) {
            return [];
        }
        await this.appendQueue;
        this.ensureOpen();
        return this.log.getEvents();
    }

    async getSnapshot(sessionId: string): Promise<AgentSnapshot> {
        if (sessionId !== this.sessionId) {
            return new SessionEventLog().getSnapshot(defaultSession(sessionId));
        }
        await this.appendQueue;
        this.ensureOpen();
        return this.log.getSnapshot(deriveSession(this.sessionId, this.log.getEvents()));
    }

    async getGraphSnapshot(sessionId: string, graphId: string): Promise<AbgGraphSnapshot> {
        if (sessionId !== this.sessionId) {
            return new SessionEventLog().getGraphSnapshot(graphId);
        }
        await this.appendQueue;
        this.ensureOpen();
        return this.log.getGraphSnapshot(graphId);
    }

    async getTimeline(sessionId: string): Promise<readonly AbgTimelineEntry[]> {
        if (sessionId !== this.sessionId) {
            return [];
        }
        await this.appendQueue;
        this.ensureOpen();
        return this.log.getTimeline();
    }

    async compact(_sessionId: string): Promise<void> {}

    async close(): Promise<void> {
        if (this.closed) {
            return;
        }
        this.stopHeartbeat();
        await this.appendQueue;
        this.closed = true;
        try {
            await this.fileHandle.close();
        } finally {
            await releaseSessionLock(this.lockHandle, this.lockPath);
        }
    }

    private async writeRecord(record: ReturnType<typeof createJsonlSessionEventRecord>): Promise<void> {
        this.ensureOpen();
        await this.fileHandle.writeFile(serializeJsonlRecord(record), 'utf8');
        await this.fileHandle.sync();
    }

    private ensureOpen(): void {
        if (this.heartbeatFailure !== undefined) {
            throw this.heartbeatFailure;
        }
        if (this.closed) {
            throw jsonlStoreError({
                code: 'write_failed',
                message: `JSONL session log ${this.sessionId} is already closed`,
                sessionId: this.sessionId,
                path: this.filePath,
            });
        }
    }

    private ensureWritableEvent(event: AgentEvent): void {
        if (event.sessionId === undefined) {
            throw jsonlStoreError({
                code: 'invalid_event',
                message: `JSONL session log ${this.sessionId} cannot append an event without sessionId`,
                sessionId: this.sessionId,
                path: this.filePath,
            });
        }
        if (event.sessionId !== this.sessionId) {
            throw sessionMismatch(this.sessionId, this.filePath);
        }
    }

    private ensureWritableEnvelope(envelope: AgentEventEnvelope): void {
        if (envelope.sessionId !== this.sessionId || envelope.event.sessionId !== this.sessionId) {
            throw sessionMismatch(this.sessionId, this.filePath);
        }
        if (envelope.sequence !== this.nextSequence) {
            throw jsonlStoreError({
                code: 'invalid_sequence',
                message: `JSONL session log ${this.sessionId} expected sequence ${this.nextSequence} but received ${envelope.sequence}`,
                sessionId: this.sessionId,
                path: this.filePath,
            });
        }
    }

    private startHeartbeat(intervalMs: number): void {
        this.heartbeatTimer = setInterval(() => {
            void this.enqueueAppend(() => this.refreshLockLease()).catch((error: unknown) => {
                this.heartbeatFailure = error;
                this.stopHeartbeat();
            });
        }, intervalMs);
        this.heartbeatTimer.unref?.();
    }

    private stopHeartbeat(): void {
        if (this.heartbeatTimer !== undefined) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = undefined;
        }
    }

    private async refreshLockLease(): Promise<void> {
        const refreshed = await heartbeatJsonlSessionLock({
            lockHandle: this.lockHandle,
            lockPath: this.lockPath,
            lockLease: this.lockLease,
            now: this.now,
        });
        this.lockHandle = refreshed.lockHandle;
        this.lockLease = refreshed.lockLease;
    }
}
