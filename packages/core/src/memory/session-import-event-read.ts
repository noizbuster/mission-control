import type { Client } from '@libsql/client';
import { type AgentEventEnvelope, AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { drizzleFromClient } from '../db/drizzle-client';
import { sessionEvents } from '../db/schema';

export const storedEventRowSchema = z.object({
    sessionId: z.string(),
    eventId: z.string(),
    seq: z.coerce.number().int().nonnegative(),
    timestamp: z.string(),
    payloadJson: z.string(),
});

export type StoredEventRow = z.infer<typeof storedEventRowSchema>;

export async function readCanonicalSessionEnvelopes(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly AgentEventEnvelope[]> {
    const db = drizzleFromClient(input.client);
    const rows = await db
        .select({
            sessionId: sessionEvents.sessionId,
            eventId: sessionEvents.eventId,
            seq: sessionEvents.seq,
            timestamp: sessionEvents.timestamp,
            payloadJson: sessionEvents.payloadJson,
        })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, input.sessionId))
        .orderBy(asc(sessionEvents.seq));
    return rows.map((row) => storedEnvelope(storedEventRowSchema.parse(row)));
}

export function storedEnvelope(row: StoredEventRow): AgentEventEnvelope {
    const value: unknown = JSON.parse(row.payloadJson);
    const parsed = AgentEventEnvelopeSchema.safeParse(value);
    if (parsed.success) return parsed.data;
    return AgentEventEnvelopeSchema.parse({
        eventId: row.eventId,
        sequence: row.seq,
        createdAt: row.timestamp,
        sessionId: row.sessionId,
        durability: 'durable',
        event: value,
    });
}
