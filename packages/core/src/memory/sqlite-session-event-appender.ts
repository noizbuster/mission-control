import {
    type AgentEvent,
    type AgentEventEnvelope,
    AgentEventEnvelopeSchema,
    AgentEventSchema,
} from '@mission-control/protocol';
import type { LocalLibsqlDb } from '../db/local-libsql-db.js';
import { toolCallsFromEvent } from '../desktop-tool-approval-authority.js';
import {
    type ObservabilityRedactor,
    redactAgentEventEnvelopeForObservability,
    redactAgentEventForObservability,
} from '../providers/observability-redactor.js';
import type { JsonlSessionEventIdFactory } from './jsonl-session-event-store.js';
import { recordSqliteDesktopToolProposals } from './sqlite-session-desktop-tool-proposals.js';
import { appendParsedSqliteEnvelope, ensureWritableEvent } from './sqlite-session-event-store-append.js';
import { ensureSqliteSessionRows, readSqliteNextSequence } from './sqlite-session-event-store-sql.js';

type SqliteSessionEventAppenderOptions = {
    readonly runtime: LocalLibsqlDb;
    readonly sessionId: string;
    readonly now: () => string;
    readonly createEventId: JsonlSessionEventIdFactory;
    readonly observabilityRedactor: ObservabilityRedactor;
    readonly enqueueWrite: <Result>(write: () => Promise<Result>) => Promise<Result>;
};

export class SqliteSessionEventAppender {
    constructor(private readonly options: SqliteSessionEventAppenderOptions) {}

    async append(event: AgentEvent): Promise<void> {
        const toolCalls = toolCallsFromEvent(event);
        const parsedEvent = AgentEventSchema.parse(
            redactAgentEventForObservability(event, this.options.observabilityRedactor),
        );
        ensureWritableEvent({ sessionId: this.options.sessionId, event: parsedEvent });
        await this.options.enqueueWrite(async () => {
            const createdAt = this.options.now();
            await this.ensureSessionRows(createdAt);
            await recordSqliteDesktopToolProposals(
                this.options.runtime.client,
                this.options.sessionId,
                toolCalls,
                createdAt,
            );
            const sequence = await this.readNextSequence();
            const envelope = AgentEventEnvelopeSchema.parse({
                eventId: this.options.createEventId(parsedEvent, sequence),
                sequence,
                createdAt: this.options.now(),
                sessionId: this.options.sessionId,
                durability: 'durable',
                event: parsedEvent,
            });
            await this.appendParsedEnvelope(envelope, sequence);
        });
    }

    async appendEnvelope(envelope: AgentEventEnvelope): Promise<void> {
        const toolCalls = toolCallsFromEvent(envelope.event);
        const parsedEnvelope = AgentEventEnvelopeSchema.parse(
            redactAgentEventEnvelopeForObservability(envelope, this.options.observabilityRedactor),
        );
        if (parsedEnvelope.durability === 'ephemeral') {
            return;
        }
        await this.options.enqueueWrite(async () => {
            await this.ensureSessionRows(parsedEnvelope.createdAt);
            await recordSqliteDesktopToolProposals(
                this.options.runtime.client,
                this.options.sessionId,
                toolCalls,
                parsedEnvelope.createdAt,
            );
            const sequence = await this.readNextSequence();
            await this.appendParsedEnvelope(parsedEnvelope, sequence);
        });
    }

    async appendEnvelopeWithStoreSequence(envelope: AgentEventEnvelope): Promise<void> {
        const parsedEnvelope = AgentEventEnvelopeSchema.parse(
            redactAgentEventEnvelopeForObservability(envelope, this.options.observabilityRedactor),
        );
        if (parsedEnvelope.durability === 'ephemeral') {
            return;
        }
        await this.options.enqueueWrite(async () => {
            await this.ensureSessionRows(parsedEnvelope.createdAt);
            const sequence = await this.readNextSequence();
            await this.appendParsedEnvelope({ ...parsedEnvelope, sequence }, sequence);
        });
    }

    private async readNextSequence(): Promise<number> {
        return readSqliteNextSequence({
            client: this.options.runtime.client,
            sessionId: this.options.sessionId,
        });
    }

    private async appendParsedEnvelope(envelope: AgentEventEnvelope, expectedSequence: number): Promise<void> {
        await appendParsedSqliteEnvelope({
            client: this.options.runtime.client,
            sessionId: this.options.sessionId,
            envelope,
            expectedSequence,
            now: this.options.now,
        });
    }

    private async ensureSessionRows(createdAt: string): Promise<void> {
        await ensureSqliteSessionRows({
            client: this.options.runtime.client,
            sessionId: this.options.sessionId,
            createdAt,
        });
    }
}
