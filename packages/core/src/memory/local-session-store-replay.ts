import type { Client } from '@libsql/client';
import { eq } from 'drizzle-orm';
import {
    createObservabilityRedactor,
    type ObservabilityRedactor,
    redactAgentEventEnvelopeForObservability,
} from '../providers/observability-redactor';
import { type JsonlSessionReplayPrefixProjection, projectSessionReplay } from '../session-replay';
import { drizzleFromClient } from '../db/drizzle-client';
import { sessions } from '../db/schema';
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
    const db = drizzleFromClient(client);
    const rows = await db
        .select({ sessionId: sessions.sessionId })
        .from(sessions)
        .where(eq(sessions.sessionId, sessionId))
        .limit(1);
    return rows.length > 0;
}
