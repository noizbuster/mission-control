import type { Client } from '@libsql/client';
import type { AgentEventEnvelope } from '@mission-control/protocol';
import { envelopeFromPayloadRow } from './sqlite-session-event-store-rows.js';

export async function readSqliteSessionEnvelopes(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly AgentEventEnvelope[]> {
    const rows = await input.client.execute({
        sql: 'SELECT payload_json FROM session_events WHERE session_id = ? ORDER BY seq ASC',
        args: [input.sessionId],
    });
    return rows.rows.map(envelopeFromPayloadRow);
}
