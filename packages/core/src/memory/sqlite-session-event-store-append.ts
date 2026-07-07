import type { Client } from '@libsql/client';
import type { AgentEvent, AgentEventEnvelope } from '@mission-control/protocol';
import { SqliteSessionEventStoreError } from './sqlite-session-event-store-errors.js';
import { replaceSqliteSessionProjection } from './sqlite-session-event-store-projection.js';
import { readSqliteSessionEnvelopes } from './sqlite-session-event-store-read.js';
import {
    hasSqliteEventId,
    insertSqliteSessionEnvelope,
    updateSqliteSessionAfterAppend,
} from './sqlite-session-event-store-sql.js';

export async function appendParsedSqliteEnvelope(input: {
    readonly client: Client;
    readonly sessionId: string;
    readonly envelope: AgentEventEnvelope;
    readonly expectedSequence: number;
    readonly now: () => string;
}): Promise<void> {
    ensureWritableEnvelope({
        sessionId: input.sessionId,
        envelope: input.envelope,
        expectedSequence: input.expectedSequence,
    });
    await rejectDuplicateEventId({
        client: input.client,
        sessionId: input.sessionId,
        eventId: input.envelope.eventId,
    });
    await insertSqliteSessionEnvelope({ client: input.client, sessionId: input.sessionId, envelope: input.envelope });
    await updateSqliteSessionAfterAppend({
        client: input.client,
        sessionId: input.sessionId,
        event: input.envelope.event,
        sequence: input.envelope.sequence,
        eventId: input.envelope.eventId,
        sequenceUpdatedAt: input.now(),
        activityAt: input.envelope.event.timestamp,
    });
    await replaceSqliteSessionProjection({
        client: input.client,
        sessionId: input.sessionId,
        envelopes: await readSqliteSessionEnvelopes({ client: input.client, sessionId: input.sessionId }),
    });
}

export function ensureWritableEvent(input: { readonly sessionId: string; readonly event: AgentEvent }): void {
    if (input.event.sessionId === undefined) {
        throw new SqliteSessionEventStoreError({
            code: 'invalid_event',
            sessionId: input.sessionId,
            message: `SQLite session log ${input.sessionId} cannot append an event without sessionId`,
        });
    }
    if (input.event.sessionId !== input.sessionId) {
        throwSessionMismatch(input.sessionId);
    }
}

function ensureWritableEnvelope(input: {
    readonly sessionId: string;
    readonly envelope: AgentEventEnvelope;
    readonly expectedSequence: number;
}): void {
    if (input.envelope.sessionId !== input.sessionId || input.envelope.event.sessionId !== input.sessionId) {
        throwSessionMismatch(input.sessionId);
    }
    if (input.envelope.sequence !== input.expectedSequence) {
        throw new SqliteSessionEventStoreError({
            code: 'invalid_sequence',
            sessionId: input.sessionId,
            message: `SQLite session log ${input.sessionId} expected sequence ${input.expectedSequence} but received ${input.envelope.sequence}`,
        });
    }
}

async function rejectDuplicateEventId(input: {
    readonly client: Client;
    readonly sessionId: string;
    readonly eventId: string;
}): Promise<void> {
    if (await hasSqliteEventId({ client: input.client, sessionId: input.sessionId, eventId: input.eventId })) {
        throw new SqliteSessionEventStoreError({
            code: 'duplicate_event_id',
            sessionId: input.sessionId,
            message: `SQLite session log ${input.sessionId} already has event id ${input.eventId}`,
        });
    }
}

function throwSessionMismatch(sessionId: string): never {
    throw new SqliteSessionEventStoreError({
        code: 'session_mismatch',
        sessionId,
        message: `SQLite session log ${sessionId} cannot store an event for another session`,
    });
}
