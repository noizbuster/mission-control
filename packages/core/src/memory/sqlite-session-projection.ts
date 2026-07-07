import type { AgentEventEnvelope } from '@mission-control/protocol';
import { type LocalLibsqlDb, openLocalLibsqlDb, runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import { deriveSessionIndexRecordsFromEnvelopes } from './session-index-projection.js';
import type {
    SessionIndexApprovalRecord,
    SessionIndexDiagnostic,
    SessionIndexProviderFailureRecord,
    SessionIndexRebuildResult,
    SessionIndexRecord,
    SessionIndexRunRecord,
    SessionIndexSessionRecord,
    SessionIndexStore,
    SessionIndexToolRecord,
} from './session-index-types.js';
import { parseSqliteProjectionInput } from './sqlite-session-projection-input.js';
import {
    approvalRecordFromRow,
    approvalRowSchema,
    diagnosticFromRow,
    diagnosticRowSchema,
    providerFailureRecordFromRow,
    providerFailureRowSchema,
    runRecordFromRow,
    runRowSchema,
    sessionRecordFromRow,
    sessionRowSchema,
    toolRecordFromRow,
    toolRowSchema,
} from './sqlite-session-projection-rows.js';
import { replaceStatements } from './sqlite-session-projection-statements.js';

export type SqliteSessionIndexStore = SessionIndexStore & {
    replaceSessionProjection(input: {
        readonly sessionId: string;
        readonly records: readonly SessionIndexRecord[];
        readonly diagnostics: readonly SessionIndexDiagnostic[];
        readonly envelopes: readonly AgentEventEnvelope[];
    }): Promise<void>;
    close(): void;
};

export async function createSqliteSessionIndexStore(input: { readonly url: string }): Promise<SqliteSessionIndexStore> {
    const runtime = await openLocalLibsqlDb({ url: input.url });
    return new LibsqlSessionIndexStore(runtime);
}

export async function projectSessionEventsToSqlite(input: {
    readonly store: SqliteSessionIndexStore;
    readonly sessionId: string;
    readonly sourceFilePath: string;
    readonly envelopes: readonly unknown[];
}): Promise<SessionIndexRebuildResult> {
    const parsed = parseSqliteProjectionInput(input);
    if (parsed.kind === 'diagnostic') {
        await input.store.replaceSessionProjection({
            sessionId: input.sessionId,
            records: [],
            diagnostics: [parsed.diagnostic],
            envelopes: [],
        });
        return { sessionId: input.sessionId, indexedRecords: 0, diagnostics: [parsed.diagnostic] };
    }
    const projection = deriveSessionIndexRecordsFromEnvelopes({
        sessionId: input.sessionId,
        filePath: input.sourceFilePath,
        envelopes: parsed.envelopes,
    });
    await input.store.replaceSessionProjection({
        sessionId: input.sessionId,
        records: projection.records,
        diagnostics: projection.diagnostics,
        envelopes: parsed.envelopes,
    });
    return {
        sessionId: input.sessionId,
        indexedRecords: projection.records.length,
        diagnostics: projection.diagnostics,
    };
}

class LibsqlSessionIndexStore implements SqliteSessionIndexStore {
    private readonly runtime: LocalLibsqlDb;

    constructor(runtime: LocalLibsqlDb) {
        this.runtime = runtime;
    }

    async replaceSessionIndex(input: {
        readonly sessionId: string;
        readonly records: readonly SessionIndexRecord[];
        readonly diagnostics: readonly SessionIndexDiagnostic[];
    }): Promise<void> {
        await this.replaceSessionProjection({ ...input, envelopes: [] });
    }

    async replaceSessionProjection(input: {
        readonly sessionId: string;
        readonly records: readonly SessionIndexRecord[];
        readonly diagnostics: readonly SessionIndexDiagnostic[];
        readonly envelopes: readonly AgentEventEnvelope[];
    }): Promise<void> {
        await runLocalLibsqlWrite(this.runtime, (client) => client.batch([...replaceStatements(input)], 'write'));
    }

    async listSessions(): Promise<readonly SessionIndexSessionRecord[]> {
        const result = await this.runtime.client.execute(sessionSelectSql('ORDER BY s.updated_at, s.session_id'));
        return result.rows.map((row) => sessionRowSchema.parse(row)).map(sessionRecordFromRow);
    }

    async getSession(sessionId: string): Promise<SessionIndexSessionRecord | null> {
        const result = await this.runtime.client.execute({
            sql: sessionSelectSql('WHERE s.session_id = ?'),
            args: [sessionId],
        });
        const row = result.rows[0];
        return row === undefined ? null : sessionRecordFromRow(sessionRowSchema.parse(row));
    }

    async getRuns(sessionId: string): Promise<readonly SessionIndexRunRecord[]> {
        const result = await this.runtime.client.execute({
            sql: 'SELECT * FROM session_index_runs WHERE session_id = ? ORDER BY sequence, event_id',
            args: [sessionId],
        });
        return result.rows.map((row) => runRecordFromRow(runRowSchema.parse(row)));
    }

    async getApprovals(sessionId: string): Promise<readonly SessionIndexApprovalRecord[]> {
        const result = await this.runtime.client.execute({
            sql: 'SELECT * FROM approvals WHERE session_id = ? ORDER BY approval_id',
            args: [sessionId],
        });
        return result.rows.map((row) => approvalRecordFromRow(approvalRowSchema.parse(row)));
    }

    async getTools(sessionId: string): Promise<readonly SessionIndexToolRecord[]> {
        const result = await this.runtime.client.execute({
            sql: 'SELECT * FROM tool_calls WHERE session_id = ? ORDER BY tool_call_id',
            args: [sessionId],
        });
        return result.rows.map((row) => toolRecordFromRow(toolRowSchema.parse(row)));
    }

    async getProviderFailures(sessionId: string): Promise<readonly SessionIndexProviderFailureRecord[]> {
        const result = await this.runtime.client.execute({
            sql: 'SELECT * FROM provider_failures WHERE session_id = ? ORDER BY event_id',
            args: [sessionId],
        });
        return result.rows.map((row) => providerFailureRecordFromRow(providerFailureRowSchema.parse(row)));
    }

    async getDiagnostics(sessionId: string): Promise<readonly SessionIndexDiagnostic[]> {
        const result = await this.runtime.client.execute({
            sql: `
                SELECT * FROM session_index_diagnostics
                WHERE session_id = ?
                ORDER BY file_path, code, COALESCE(line_number, 0), message
            `,
            args: [sessionId],
        });
        return result.rows.map((row) => diagnosticRowSchema.parse(row)).map(diagnosticFromRow);
    }

    close(): void {
        this.runtime.close();
    }
}

function sessionSelectSql(suffix: string): string {
    return `
        SELECT s.session_id, s.status, s.created_at, s.stopped_at, s.last_event_seq, s.updated_at,
               s.awaiting_reason, s.primary_wait_id, s.legacy_jsonl_path, s.metadata_json,
               w.source_kind AS wait_source_kind, w.source_id AS wait_source_id,
               w.run_id AS wait_run_id, w.tool_call_id AS wait_tool_call_id,
               w.approval_id AS wait_approval_id, w.job_id AS wait_job_id,
               w.child_session_id AS wait_child_session_id
        FROM sessions s
        LEFT JOIN session_awaits w ON w.session_id = s.session_id AND w.wait_id = s.primary_wait_id
        ${suffix}
    `;
}
