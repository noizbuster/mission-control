import type { Client, InStatement } from '@libsql/client';
import { type AgentEventEnvelope, AgentEventEnvelopeSchema } from '@mission-control/protocol';
import { z } from 'zod';
import { type LocalLibsqlWriteTarget, runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import { ensureLocalDbSchema } from '../db/local-libsql-schema.js';
import { ensureLegacySessionImportTables } from './session-import-sql.js';
import { deriveSessionIndexRecordsFromEnvelopes } from './session-index-projection.js';
import { replaceStatements } from './sqlite-session-projection-statements.js';

const exportEventRowSchema = z.object({
    event_id: z.string(),
    seq: z.coerce.number().int().nonnegative(),
    timestamp: z.string(),
    payload_json: z.string(),
});

export async function importJsonlSessionRows(
    input: LocalLibsqlWriteTarget & {
        readonly sessionId: string;
        readonly sourcePath: string;
        readonly createdAt: string;
        readonly importedAt: string;
        readonly envelopes: readonly AgentEventEnvelope[];
    },
): Promise<void> {
    const lastEnvelope = input.envelopes.at(-1);
    const lastActivityAt = lastEnvelope?.event.timestamp ?? input.createdAt;
    const stoppedAt = stoppedAtFor(input.envelopes);
    const projection = deriveSessionIndexRecordsFromEnvelopes({
        sessionId: input.sessionId,
        filePath: input.sourcePath,
        envelopes: input.envelopes,
    });
    await runLocalLibsqlWrite(input, async (client) => {
        await ensureSqliteSessionProjectionTables(client);
        await client.batch(
            [
                upsertSessionStatement({
                    sessionId: input.sessionId,
                    status: stoppedAt === undefined ? 'running' : 'stopped',
                    createdAt: input.createdAt,
                    updatedAt: lastActivityAt,
                    lastActivityAt,
                    lastEventSeq: lastEnvelope?.sequence ?? 0,
                    legacyJsonlPath: input.sourcePath,
                    importedAt: input.importedAt,
                    ...(stoppedAt !== undefined ? { stoppedAt } : {}),
                }),
                upsertSequenceStatement({
                    sessionId: input.sessionId,
                    nextSeq: (lastEnvelope?.sequence ?? -1) + 1,
                    updatedAt: input.importedAt,
                }),
                ...input.envelopes.map((envelope) => insertEventStatement(envelope)),
                ...replaceStatements({
                    sessionId: input.sessionId,
                    records: projection.records,
                    diagnostics: projection.diagnostics,
                    envelopes: input.envelopes,
                }),
            ],
            'write',
        );
    });
}

async function ensureSqliteSessionProjectionTables(client: Client): Promise<void> {
    await ensureLocalDbSchema(client);
}

export async function readExportEnvelopes(input: {
    readonly client: Client;
    readonly sessionId: string;
}): Promise<readonly AgentEventEnvelope[]> {
    await ensureLegacySessionImportTables(input.client);
    const result = await input.client.execute({
        sql: 'SELECT event_id, seq, timestamp, payload_json FROM session_events WHERE session_id = ? ORDER BY seq',
        args: [input.sessionId],
    });
    return result.rows.map((row) => envelopeFromExportRow(exportEventRowSchema.parse(row), input.sessionId));
}

export async function markSessionExported(
    input: LocalLibsqlWriteTarget & {
        readonly sessionId: string;
        readonly exportedAt: string;
    },
): Promise<void> {
    await runLocalLibsqlWrite(input, (client) => {
        return client.execute({
            sql: 'UPDATE sessions SET exported_at = ? WHERE session_id = ?',
            args: [input.exportedAt, input.sessionId],
        });
    });
}

function upsertSessionStatement(input: {
    readonly sessionId: string;
    readonly status: string;
    readonly createdAt: string;
    readonly updatedAt: string;
    readonly lastActivityAt: string;
    readonly lastEventSeq: number;
    readonly legacyJsonlPath: string;
    readonly importedAt: string;
    readonly stoppedAt?: string;
}): InStatement {
    return {
        sql: `
            INSERT INTO sessions
                (session_id, status, created_at, updated_at, last_activity_at, last_event_seq,
                 legacy_jsonl_path, imported_at, stopped_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                status = excluded.status,
                updated_at = excluded.updated_at,
                last_activity_at = excluded.last_activity_at,
                last_event_seq = MAX(sessions.last_event_seq, excluded.last_event_seq),
                legacy_jsonl_path = COALESCE(sessions.legacy_jsonl_path, excluded.legacy_jsonl_path),
                imported_at = COALESCE(sessions.imported_at, excluded.imported_at),
                stopped_at = COALESCE(excluded.stopped_at, sessions.stopped_at)
        `,
        args: [
            input.sessionId,
            input.status,
            input.createdAt,
            input.updatedAt,
            input.lastActivityAt,
            input.lastEventSeq,
            input.legacyJsonlPath,
            input.importedAt,
            input.stoppedAt ?? null,
        ],
    };
}

function upsertSequenceStatement(input: {
    readonly sessionId: string;
    readonly nextSeq: number;
    readonly updatedAt: string;
}): InStatement {
    return {
        sql: `
            INSERT INTO session_event_sequences (session_id, next_seq, updated_at)
            VALUES (?, ?, ?)
            ON CONFLICT(session_id) DO UPDATE SET
                next_seq = MAX(session_event_sequences.next_seq, excluded.next_seq),
                updated_at = excluded.updated_at
        `,
        args: [input.sessionId, input.nextSeq, input.updatedAt],
    };
}

function insertEventStatement(envelope: AgentEventEnvelope): InStatement {
    return {
        sql: `
            INSERT OR IGNORE INTO session_events
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

function stoppedAtFor(envelopes: readonly AgentEventEnvelope[]): string | undefined {
    for (let index = envelopes.length - 1; index >= 0; index -= 1) {
        const envelope = envelopes[index];
        if (envelope?.event.type === 'session.stopped') {
            return envelope.event.timestamp;
        }
    }
    return undefined;
}

function envelopeFromExportRow(row: z.infer<typeof exportEventRowSchema>, sessionId: string): AgentEventEnvelope {
    const value: unknown = JSON.parse(row.payload_json);
    const parsed = AgentEventEnvelopeSchema.safeParse(value);
    if (parsed.success) {
        return parsed.data;
    }
    return AgentEventEnvelopeSchema.parse({
        eventId: row.event_id,
        sequence: row.seq,
        createdAt: row.timestamp,
        sessionId,
        durability: 'durable',
        event: value,
    });
}
