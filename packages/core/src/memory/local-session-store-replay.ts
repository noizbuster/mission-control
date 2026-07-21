import type { Client } from '@libsql/client';
import {
    createObservabilityRedactor,
    type ObservabilityRedactor,
    redactAgentEventEnvelopeForObservability,
} from '../providers/observability-redactor';
import { type JsonlSessionReplayPrefixProjection, projectSessionReplay } from '../session-replay';
import { resolveMissionControlDataDir } from './data-dir';
import { openEnsuredLocalSessionDatabase } from './local-session-store-database';
import { readCanonicalSessionEnvelopes } from './session-import-event-read';

export type LocalSessionReplayReadResult =
    | {
          readonly kind: 'found';
          readonly replay: JsonlSessionReplayPrefixProjection;
      }
    | {
          readonly kind: 'missing';
      };

export async function readLocalSessionReplay(input: {
    readonly dataDir?: string;
    readonly sessionId: string;
    readonly now?: () => string;
    readonly observabilityRedactor?: ObservabilityRedactor;
}): Promise<LocalSessionReplayReadResult> {
    const dataDir = input.dataDir ?? resolveMissionControlDataDir();
    const observabilityRedactor = input.observabilityRedactor ?? createObservabilityRedactor();
    const { runtime } = await openEnsuredLocalSessionDatabase({
        dataDir,
        ...(input.now !== undefined ? { now: input.now } : {}),
        observabilityRedactor,
    });
    try {
        if (!(await hasSqliteSession(runtime.client, input.sessionId))) {
            return { kind: 'missing' };
        }
        const envelopes = (
            await readCanonicalSessionEnvelopes({ client: runtime.client, sessionId: input.sessionId })
        ).map((envelope) => redactAgentEventEnvelopeForObservability(envelope, observabilityRedactor));
        if (envelopes.length === 0) {
            return { kind: 'missing' };
        }
        const projection = projectSessionReplay({ sessionId: input.sessionId, envelopes });
        return { kind: 'found', replay: { projection, diagnostics: projection.diagnostics } };
    } finally {
        runtime.close();
    }
}

async function hasSqliteSession(client: Client, sessionId: string): Promise<boolean> {
    const result = await client.execute({
        sql: 'SELECT session_id FROM sessions WHERE session_id = ? LIMIT 1',
        args: [sessionId],
    });
    return result.rows.length > 0;
}
