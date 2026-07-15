import type { Client } from '@libsql/client';
import type { AgentEventEnvelope } from '@mission-control/protocol';
import { LegacySessionImportConflictError } from './session-import-conflict.js';
import { type StoredEventRow, storedEnvelope, storedEventRowSchema } from './session-import-event-read.js';

const EVENT_ID_QUERY_CHUNK_SIZE = 500;

export async function absentExactLegacyEnvelopes(
    client: Client,
    envelopes: readonly AgentEventEnvelope[],
): Promise<readonly AgentEventEnvelope[]> {
    const rows = await existingIdentityRows(client, envelopes);
    const rowsBySequence = new Map(rows.map((row) => [`${row.session_id}\0${row.seq}`, row]));
    const rowsByEventId = new Map(rows.map((row) => [row.event_id, row]));
    const absent: AgentEventEnvelope[] = [];
    for (const envelope of envelopes) {
        const sequenceRow = rowsBySequence.get(`${envelope.sessionId}\0${envelope.sequence}`);
        const eventIdRow = rowsByEventId.get(envelope.eventId);
        if (sequenceRow === undefined && eventIdRow === undefined) {
            absent.push(envelope);
            continue;
        }
        if (sequenceRow !== undefined && !sameStoredEnvelope(sequenceRow, envelope)) {
            throw new LegacySessionImportConflictError(
                'sequence_collision',
                envelope.sessionId,
                envelope.sequence,
                envelope.eventId,
            );
        }
        if (eventIdRow !== undefined && !sameStoredEnvelope(eventIdRow, envelope)) {
            throw new LegacySessionImportConflictError(
                'event_id_collision',
                envelope.sessionId,
                envelope.sequence,
                envelope.eventId,
            );
        }
    }
    return absent;
}

async function existingIdentityRows(
    client: Client,
    envelopes: readonly AgentEventEnvelope[],
): Promise<readonly StoredEventRow[]> {
    const first = envelopes[0];
    if (first === undefined) return [];
    const rowsByPrimaryKey = new Map<string, StoredEventRow>();
    for (let offset = 0; offset < envelopes.length; offset += EVENT_ID_QUERY_CHUNK_SIZE) {
        const chunk = envelopes.slice(offset, offset + EVENT_ID_QUERY_CHUNK_SIZE);
        const sequences = chunk.map(({ sequence }) => sequence);
        const sequenceResult = await client.execute({
            sql: `
                SELECT session_id, event_id, seq, timestamp, payload_json
                FROM session_events WHERE session_id = ? AND seq IN (${sequences.map(() => '?').join(', ')})
            `,
            args: [first.sessionId, ...sequences],
        });
        const eventIds = chunk.map(({ eventId }) => eventId);
        const eventIdResult = await client.execute({
            sql: `
                SELECT session_id, event_id, seq, timestamp, payload_json
                FROM session_events WHERE event_id IN (${eventIds.map(() => '?').join(', ')})
            `,
            args: eventIds,
        });
        for (const row of [...sequenceResult.rows, ...eventIdResult.rows]) {
            const parsed = storedEventRowSchema.parse(row);
            rowsByPrimaryKey.set(`${parsed.session_id}\0${parsed.seq}`, parsed);
        }
    }
    return [...rowsByPrimaryKey.values()];
}

function sameStoredEnvelope(row: Parameters<typeof storedEnvelope>[0], envelope: AgentEventEnvelope): boolean {
    return (
        row.session_id === envelope.sessionId &&
        row.seq === envelope.sequence &&
        row.event_id === envelope.eventId &&
        row.timestamp === envelope.event.timestamp &&
        JSON.stringify(storedEnvelope(row)) === JSON.stringify(envelope)
    );
}
