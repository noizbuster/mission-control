import type { InStatement } from '@libsql/client';
import type { AgentEventEnvelope } from '@mission-control/protocol';
import { type LocalLibsqlWriteTarget, runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import { runLocalLibsqlClientTransaction } from '../db/local-libsql-transaction.js';
import { refreshSessionAwaitingFromPendingWaits } from './session-awaiting-sql.js';
import { absentExactLegacyEnvelopes } from './session-import-event-identities.js';
import { readCanonicalSessionEnvelopes } from './session-import-event-read.js';
import { hasLegacyImport, recordLegacyImport } from './session-import-sql.js';
import { importedSessionSummaryStatements, maximumIsoTimestamp } from './session-import-summary-sql.js';
import { deriveSessionProjectionRecordsFromEnvelopes } from './session-projection.js';
import { ensureSqliteSessionRows } from './sqlite-session-event-store-sql.js';
import { replaceStatements } from './sqlite-session-projection-statements.js';

export type JsonlSessionRowsImportResult =
    | { readonly kind: 'source_skipped' }
    | { readonly kind: 'imported'; readonly insertedEventCount: number };

export async function importJsonlSessionRows(
    input: LocalLibsqlWriteTarget & {
        readonly sessionId: string;
        readonly sourcePath: string;
        readonly sourceChecksum: string;
        readonly importId: string;
        readonly createdAt: string;
        readonly importedAt: string;
        readonly envelopes: readonly AgentEventEnvelope[];
    },
): Promise<JsonlSessionRowsImportResult> {
    return runLocalLibsqlWrite(input, (client) =>
        runLocalLibsqlClientTransaction(client, async () => {
            if (
                await hasLegacyImport({
                    client,
                    sourcePath: input.sourcePath,
                    checksum: input.sourceChecksum,
                })
            ) {
                return { kind: 'source_skipped' };
            }
            const absent = await absentExactLegacyEnvelopes(client, input.envelopes);
            await ensureSqliteSessionRows({ client, sessionId: input.sessionId, createdAt: input.createdAt });
            await client.execute({
                sql: `
                    UPDATE sessions SET
                        legacy_jsonl_path = COALESCE(legacy_jsonl_path, ?),
                        imported_at = COALESCE(imported_at, ?)
                    WHERE session_id = ?
                `,
                args: [input.sourcePath, input.importedAt, input.sessionId],
            });
            let insertedEventCount = 0;
            for (const envelope of absent) {
                const result = await client.execute(insertEventStatement(envelope));
                insertedEventCount += result.rowsAffected;
            }
            const canonicalEnvelopes = await readCanonicalSessionEnvelopes({ client, sessionId: input.sessionId });
            if (canonicalEnvelopes.length > 0) {
                const projection = deriveSessionProjectionRecordsFromEnvelopes({
                    sessionId: input.sessionId,
                    filePath: input.sourcePath,
                    envelopes: canonicalEnvelopes,
                });
                const statements = [
                    ...replaceStatements({
                        sessionId: input.sessionId,
                        records: projection.records,
                        diagnostics: projection.diagnostics,
                        envelopes: canonicalEnvelopes,
                    }),
                    ...importedSessionSummaryStatements({
                        sessionId: input.sessionId,
                        importedAt: input.importedAt,
                        envelopes: canonicalEnvelopes,
                    }),
                ];
                for (const statement of statements) await client.execute(statement);
                await refreshSessionAwaitingFromPendingWaits({
                    client,
                    sessionId: input.sessionId,
                    now: maximumActivityAt(canonicalEnvelopes),
                });
            }
            await recordLegacyImport({
                client,
                entry: {
                    importId: input.importId,
                    sourcePath: input.sourcePath,
                    sourceKind: 'jsonl',
                    checksum: input.sourceChecksum,
                    importedEventCount: insertedEventCount,
                    importedAt: input.importedAt,
                    diagnostics: [],
                },
            });
            return { kind: 'imported', insertedEventCount };
        }),
    );
}

export function readExportEnvelopes(input: {
    readonly client: LocalLibsqlWriteTarget['client'];
    readonly sessionId: string;
}): Promise<readonly AgentEventEnvelope[]> {
    return readCanonicalSessionEnvelopes(input);
}

export async function markSessionExported(
    input: LocalLibsqlWriteTarget & { readonly sessionId: string; readonly exportedAt: string },
): Promise<void> {
    await runLocalLibsqlWrite(input, (client) =>
        client.execute({
            sql: 'UPDATE sessions SET exported_at = ? WHERE session_id = ?',
            args: [input.exportedAt, input.sessionId],
        }),
    );
}

function insertEventStatement(envelope: AgentEventEnvelope): InStatement {
    return {
        sql: `
            INSERT INTO session_events
                (session_id, seq, event_id, type, timestamp, run_id, turn_id, causation_id, correlation_id, payload_json)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
            envelope.sessionId,
            envelope.sequence,
            envelope.eventId,
            envelope.event.type,
            envelope.event.timestamp,
            envelope.event.run?.runId ?? null,
            envelope.event.run?.providerTurnId ?? null,
            envelope.causationId ?? null,
            envelope.correlationId ?? null,
            JSON.stringify(envelope),
        ],
    };
}

function maximumActivityAt(envelopes: readonly AgentEventEnvelope[]): string {
    return maximumIsoTimestamp(envelopes.map(({ event }) => event.timestamp)) ?? new Date(0).toISOString();
}
