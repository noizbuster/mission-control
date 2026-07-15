import {
    type AbgGraphSnapshot,
    type AgentEvent,
    type AgentEventEnvelope,
    AgentEventEnvelopeSchema,
    AgentEventSchema,
    type AgentSnapshot,
} from '@mission-control/protocol';
import type { AbgTimelineEntry } from '../behavior/timeline';
import {
    createObservabilityRedactor,
    type ObservabilityRedactor,
    redactAgentEventEnvelopeForObservability,
    redactAgentEventForObservability,
} from '../providers/observability-redactor';
import { SessionEventLog } from '../session-log';
import { jsonlStoreError } from './jsonl-errors';
import { sessionMismatch } from './jsonl-session-event-errors';
import {
    type OpenedJsonlSessionFile,
    type OpenJsonlSessionFileOptions,
    openJsonlSessionFile,
} from './jsonl-session-files';
import { defaultSession, deriveSession } from './jsonl-session-projection';
import { createJsonlSessionEventRecord, serializeJsonlRecord } from './jsonl-session-records';
import type { MemoryStore, SessionCompactionRecordInput } from './memory-store';
import { createSessionCompactionEvent } from './session-compaction-event';
import { randomUUID } from 'node:crypto';

export { JsonlSessionEventStoreError } from './jsonl-errors';

export type JsonlSessionEventIdFactory = (event: AgentEvent, sequence: number) => string;

export type JsonlSessionEventStoreOpenOptions = Omit<OpenJsonlSessionFileOptions, 'now'> & {
    readonly now?: () => string;
    readonly createEventId?: JsonlSessionEventIdFactory;
    readonly observabilityRedactor?: ObservabilityRedactor;
};

type JsonlSessionEventStoreInput = OpenedJsonlSessionFile & {
    readonly now: () => string;
    readonly createEventId: JsonlSessionEventIdFactory;
    readonly observabilityRedactor: ObservabilityRedactor;
};

export class JsonlSessionEventStore implements MemoryStore {
    readonly sessionId: string;
    readonly filePath: string;
    private readonly fileHandle: OpenedJsonlSessionFile['fileHandle'];
    private readonly log: SessionEventLog;
    private readonly now: () => string;
    private readonly createEventId: JsonlSessionEventIdFactory;
    private readonly observabilityRedactor: ObservabilityRedactor;
    private nextSequence: number;
    private appendQueue: Promise<void> = Promise.resolve();
    private closed = false;

    private constructor(input: JsonlSessionEventStoreInput) {
        this.sessionId = input.sessionId;
        this.filePath = input.filePath;
        this.fileHandle = input.fileHandle;
        this.log = new SessionEventLog();
        this.observabilityRedactor = input.observabilityRedactor;
        for (const event of input.log.getEvents()) {
            this.log.append(redactAgentEventForObservability(event, this.observabilityRedactor));
        }
        this.now = input.now;
        this.createEventId = input.createEventId;
        this.nextSequence = input.nextSequence;
    }

    static async open(options: JsonlSessionEventStoreOpenOptions): Promise<JsonlSessionEventStore> {
        const now = options.now ?? (() => new Date().toISOString());
        const createEventId = options.createEventId ?? (() => randomUUID());
        const openedFile = await openJsonlSessionFile({ ...options, now });

        return new JsonlSessionEventStore({
            ...openedFile,
            now,
            createEventId,
            observabilityRedactor: options.observabilityRedactor ?? createObservabilityRedactor(),
        });
    }

    async append(event: AgentEvent): Promise<void> {
        const parsedEvent = AgentEventSchema.parse(redactAgentEventForObservability(event, this.observabilityRedactor));
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
        const parsedEnvelope = AgentEventEnvelopeSchema.parse(
            redactAgentEventEnvelopeForObservability(envelope, this.observabilityRedactor),
        );
        if (parsedEnvelope.durability === 'ephemeral') {
            return;
        }
        await this.enqueueAppend(() => this.appendParsedEnvelope(parsedEnvelope));
    }

    async appendEnvelopeWithStoreSequence(envelope: AgentEventEnvelope): Promise<void> {
        const parsedEnvelope = AgentEventEnvelopeSchema.parse(
            redactAgentEventEnvelopeForObservability(envelope, this.observabilityRedactor),
        );
        if (parsedEnvelope.durability === 'ephemeral') {
            return;
        }
        await this.enqueueAppend(() =>
            this.appendParsedEnvelope({
                ...parsedEnvelope,
                sequence: this.nextSequence,
            }),
        );
    }

    private async appendParsedEnvelope(envelope: AgentEventEnvelope): Promise<void> {
        this.ensureWritableEnvelope(envelope);
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
        await this.fileHandle.close();
    }

    private async writeRecord(record: ReturnType<typeof createJsonlSessionEventRecord>): Promise<void> {
        this.ensureOpen();
        await this.fileHandle.writeFile(serializeJsonlRecord(record), 'utf8');
        await this.fileHandle.sync();
    }

    private ensureOpen(): void {
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
}
