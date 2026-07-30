import type { Client } from '@libsql/client';
import type { AgentEventEnvelope } from '@mission-control/protocol';
import { drizzleFromClient } from '../db/drizzle-client';
import { refreshSessionAwaitingFromPendingWaits } from './session-awaiting-sql';
import { deriveSessionProjectionRecordsFromEnvelopes } from './session-projection';
import { replaceSessionProjectionRecords } from './sqlite-session-projection-statements';

export async function replaceSqliteSessionProjection(input: {
    readonly client: Client;
    readonly sessionId: string;
    readonly envelopes: readonly AgentEventEnvelope[];
}): Promise<void> {
    const projection = deriveSessionProjectionRecordsFromEnvelopes({
        sessionId: input.sessionId,
        filePath: `sqlite:${input.sessionId}`,
        envelopes: input.envelopes,
    });
    const db = drizzleFromClient(input.client);
    await replaceSessionProjectionRecords(db, {
        sessionId: input.sessionId,
        records: projection.records,
        diagnostics: projection.diagnostics,
        envelopes: input.envelopes,
    });
    await refreshSessionAwaitingFromPendingWaits({
        client: input.client,
        sessionId: input.sessionId,
        now: input.envelopes.at(-1)?.event.timestamp ?? new Date(0).toISOString(),
    });
}
