import type { Client } from '@libsql/client';
import { type AgentEventEnvelope, AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { z } from 'zod';

export const storedEventRowSchema = z.object({
    session_id: z.string(),
    event_id: z.string(),
    seq: z.coerce.number().int().nonnegative(),
    timestamp: z.string(),
    payload_json: z.string(),
});

export type StoredEventRow = z.infer<typeof storedEventRowSchema>;

export async function readCanonicalSessionEnvelopes(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly AgentEventEnvelope[]> {
    const result = await input.client.execute({
        sql: `
            SELECT session_id, event_id, seq, timestamp, payload_json
            FROM session_events WHERE session_id = ? ORDER BY seq
        `,
        args: [input.sessionId],
    });
    return result.rows.map((row) => storedEnvelope(storedEventRowSchema.parse(row)));
}

export function storedEnvelope(row: StoredEventRow): AgentEventEnvelope {
    const value: unknown = JSON.parse(row.payload_json);
    const parsed = AgentEventEnvelopeSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    return AgentEventEnvelopeSchema.parse({
        eventId: row.event_id,
        sequence: row.seq,
        createdAt: row.timestamp,
        sessionId: row.session_id,
        durability: 'durable',
        event: value,
    });
}
