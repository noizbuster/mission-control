import type { Client } from '@libsql/client';
import {
    createObservabilityRedactor,
    type ObservabilityRedactor,
    redactAgentEventEnvelopeForObservability,
} from '../providers/observability-redactor';
import { type JsonlSessionReplayPrefixProjection, projectSessionReplay } from '../session-replay';
import type { ReplayDiagnostic } from '../session-replay-types';
import { resolveMissionControlDataDir } from './data-dir';
import { openEnsuredLocalSessionDatabase } from './local-session-store-database';
import { readExportEnvelopes } from './session-import-event-sql';
import { listLegacySessionImportLedger } from './session-import-sql';

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
        if (await hasSqliteSession(runtime.client, input.sessionId)) {
            const envelopes = (await readExportEnvelopes({ client: runtime.client, sessionId: input.sessionId })).map(
                (envelope) => redactAgentEventEnvelopeForObservability(envelope, observabilityRedactor),
            );
            if (envelopes.length > 0) {
                const projection = projectSessionReplay({ sessionId: input.sessionId, envelopes });
                return { kind: 'found', replay: { projection, diagnostics: projection.diagnostics } };
            }
        }
        const diagnostics = await readLegacyReplayDiagnostics(runtime.client, input.sessionId);
        if (diagnostics.length > 0) {
            const projection = projectSessionReplay({ sessionId: input.sessionId, envelopes: [] });
            return { kind: 'found', replay: { projection, diagnostics } };
        }
    } finally {
        runtime.close();
    }
    return { kind: 'missing' };
}

async function hasSqliteSession(client: Client, sessionId: string): Promise<boolean> {
    const result = await client.execute({
        sql: 'SELECT session_id FROM sessions WHERE session_id = ? LIMIT 1',
        args: [sessionId],
    });
    return result.rows.length > 0;
}

async function readLegacyReplayDiagnostics(client: Client, sessionId: string): Promise<readonly ReplayDiagnostic[]> {
    const entries = await listLegacySessionImportLedger(client);
    const diagnostics: ReplayDiagnostic[] = [];
    for (const entry of entries) {
        for (const diagnostic of entry.diagnostics) {
            if (
                diagnostic.sourceKind === 'jsonl' &&
                diagnostic.code === 'corrupt_jsonl' &&
                diagnostic.sessionId === sessionId &&
                diagnostic.lineNumber !== undefined
            ) {
                diagnostics.push({ code: 'corrupt_trailing_record', lineNumber: diagnostic.lineNumber, sessionId });
            }
        }
    }
    return diagnostics;
}
