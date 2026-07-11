import type { Client } from '@libsql/client';
import type { AgentEventEnvelope } from '@mission-control/protocol';
import { refreshSessionAwaitingFromPendingWaits } from './session-awaiting-sql.js';
import { deriveSessionProjectionRecordsFromEnvelopes } from './session-projection.js';
import { replaceStatements } from './sqlite-session-projection-statements.js';

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
    for (const statement of replaceStatements({
        sessionId: input.sessionId,
        records: projection.records,
        diagnostics: projection.diagnostics,
        envelopes: input.envelopes,
    })) {
        await input.client.execute(statement);
    }
    await refreshSessionAwaitingFromPendingWaits({
        client: input.client,
        sessionId: input.sessionId,
        now: input.envelopes.at(-1)?.event.timestamp ?? new Date(0).toISOString(),
    });
}
