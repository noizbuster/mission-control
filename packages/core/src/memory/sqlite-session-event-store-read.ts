import type { Client } from '@libsql/client';
import type { AgentEventEnvelope } from '@mission-control/protocol';
import { asc, eq } from 'drizzle-orm';
import { drizzleFromClient } from '../db/drizzle-client';
import { sessionEvents } from '../db/schema';
import { envelopeFromPayloadRow } from './sqlite-session-event-store-rows';

export async function readSqliteSessionEnvelopes(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly AgentEventEnvelope[]> {
    const db = drizzleFromClient(input.client);
    const rows = await db
        .select({ payloadJson: sessionEvents.payloadJson })
        .from(sessionEvents)
        .where(eq(sessionEvents.sessionId, input.sessionId))
        .orderBy(asc(sessionEvents.seq));
    return rows.map((row) => envelopeFromPayloadRow({ payload_json: row.payloadJson }));
}
