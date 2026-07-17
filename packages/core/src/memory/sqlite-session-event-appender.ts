import {
    type AgentEvent,
    type AgentEventEnvelope,
    AgentEventEnvelopeSchema,
    AgentEventSchema,
} from '@mission-control/protocol';
import type { LocalLibsqlDb } from '../db/local-libsql-db';
import { toolCallsFromEvent } from '../desktop-tool-approval-authority';
import {
    type ObservabilityRedactor,
    redactAgentEventEnvelopeForObservability,
    redactAgentEventForObservability,
} from '../providers/observability-redactor';
import type { JsonlSessionEventIdFactory } from './jsonl-session-event-store';
import { recordSqliteDesktopToolProposals } from './sqlite-session-desktop-tool-proposals';
import { appendParsedSqliteEnvelope, ensureWritableEvent } from './sqlite-session-event-store-append';
import {
    ensureSqliteSessionRows,
    readSqliteNextSequence,
    touchSqliteSessionActivity,
} from './sqlite-session-event-store-sql';

type SqliteSessionEventAppenderOptions = {
    readonly runtime: LocalLibsqlDb;
    readonly sessionId: string;
    readonly now: () => string;
    readonly createEventId: JsonlSessionEventIdFactory;
    readonly observabilityRedactor: ObservabilityRedactor;
    readonly enqueueWrite: <Result>(write: () => Promise<Result>) => Promise<Result>;
};

const EPHEMERAL_ACTIVITY_TOUCH_MIN_MS = 1000;

export class SqliteSessionEventAppender {
    private lastEphemeralActivityTouchMs = 0;

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

    /**
     * Append many durable events inside ONE write-lane transaction. Honors abort between items so
     * interrupt can stop a multi-minute drain without waiting for the full backlog.
     */
    async appendMany(events: readonly AgentEvent[], signal?: AbortSignal): Promise<void> {
        if (events.length === 0) {
            return;
        }
        const prepared: Array<{ readonly event: AgentEvent; readonly toolCalls: ReturnType<typeof toolCallsFromEvent> }> =
            [];
        for (const event of events) {
            if (signal?.aborted === true) {
                break;
            }
            const parsedEvent = AgentEventSchema.parse(
                redactAgentEventForObservability(event, this.options.observabilityRedactor),
            );
            ensureWritableEvent({ sessionId: this.options.sessionId, event: parsedEvent });
            prepared.push({ event: parsedEvent, toolCalls: toolCallsFromEvent(parsedEvent) });
        }
        if (prepared.length === 0) {
            return;
        }
        await this.options.enqueueWrite(async () => {
            const createdAt = this.options.now();
            await this.ensureSessionRows(createdAt);
            let sequence = await this.readNextSequence();
            for (const item of prepared) {
                if (signal?.aborted === true) {
                    break;
                }
                await recordSqliteDesktopToolProposals(
                    this.options.runtime.client,
                    this.options.sessionId,
                    item.toolCalls,
                    createdAt,
                );
                const envelope = AgentEventEnvelopeSchema.parse({
                    eventId: this.options.createEventId(item.event, sequence),
                    sequence,
                    createdAt: this.options.now(),
                    sessionId: this.options.sessionId,
                    durability: 'durable',
                    event: item.event,
                });
                await this.appendParsedEnvelope(envelope, sequence);
                sequence += 1;
            }
        });
    }

    async appendEnvelope(envelope: AgentEventEnvelope): Promise<void> {
        const toolCalls = toolCallsFromEvent(envelope.event);
        const parsedEnvelope = AgentEventEnvelopeSchema.parse(
            redactAgentEventEnvelopeForObservability(envelope, this.options.observabilityRedactor),
        );
        if (parsedEnvelope.durability === 'ephemeral') {
            await this.touchEphemeralActivity(parsedEnvelope.createdAt);
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
            await this.touchEphemeralActivity(parsedEnvelope.createdAt);
            return;
        }
        await this.options.enqueueWrite(async () => {
            await this.ensureSessionRows(parsedEnvelope.createdAt);
            const sequence = await this.readNextSequence();
            await this.appendParsedEnvelope({ ...parsedEnvelope, sequence }, sequence);
        });
    }

    private async touchEphemeralActivity(activityAt: string): Promise<void> {
        const activityMs = Date.parse(activityAt);
        if (!Number.isFinite(activityMs)) {
            return;
        }
        if (
            this.lastEphemeralActivityTouchMs > 0 &&
            activityMs - this.lastEphemeralActivityTouchMs < EPHEMERAL_ACTIVITY_TOUCH_MIN_MS
        ) {
            return;
        }
        this.lastEphemeralActivityTouchMs = activityMs;
        await this.options.enqueueWrite(async () => {
            await this.ensureSessionRows(activityAt);
            await touchSqliteSessionActivity({
                client: this.options.runtime.client,
                sessionId: this.options.sessionId,
                activityAt,
                status: 'running',
            });
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
