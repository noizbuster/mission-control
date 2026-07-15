import type { InStatement } from '@libsql/client';
import type { AgentEventEnvelope } from '@mission-control/protocol';

export function importedSessionSummaryStatements(input: {
    readonly sessionId: string;
    readonly importedAt: string;
    readonly envelopes: readonly AgentEventEnvelope[];
}): readonly InStatement[] {
    const lastEnvelope = input.envelopes.at(-1);
    if (lastEnvelope === undefined) return [];
    const activityAt = maximumIsoTimestamp(input.envelopes.map(({ event }) => event.timestamp));
    const stoppedAt = maximumIsoTimestamp(
        input.envelopes.filter(({ event }) => event.type === 'session.stopped').map(({ event }) => event.timestamp),
    );
    return [
        {
            sql: `
                INSERT INTO session_event_sequences (session_id, next_seq, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(session_id) DO UPDATE SET
                    next_seq = excluded.next_seq,
                    updated_at = excluded.updated_at
            `,
            args: [input.sessionId, lastEnvelope.sequence + 1, input.importedAt],
        },
        {
            sql: `
                UPDATE sessions SET
                    updated_at = ?,
                    last_activity_at = ?,
                    last_event_seq = ?,
                    stopped_at = ?
                WHERE session_id = ?
            `,
            args: [activityAt, activityAt, lastEnvelope.sequence, stoppedAt, input.sessionId],
        },
    ];
}

export function maximumIsoTimestamp(timestamps: readonly string[]): string | null {
    let maximum: string | null = null;
    let maximumEpochMs = Number.NEGATIVE_INFINITY;
    for (const timestamp of timestamps) {
        const epochMs = Date.parse(timestamp);
        if (epochMs > maximumEpochMs) {
            maximum = timestamp;
            maximumEpochMs = epochMs;
        }
    }
    return maximum;
}
