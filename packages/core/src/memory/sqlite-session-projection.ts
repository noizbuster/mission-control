import type { AgentEventEnvelope } from '@mission-control/protocol';
import { type LocalLibsqlDb, runLocalLibsqlWrite } from '../db/local-libsql-db';
import { runLocalLibsqlClientTransaction } from '../db/local-libsql-transaction';
import { openMissionControlDb } from '../db/mission-control-db';
import { refreshSessionAwaitingFromPendingWaits } from './session-awaiting-sql';
import { deriveSessionProjectionRecordsFromEnvelopes } from './session-projection';
import type {
    SessionProjectionApprovalRecord,
    SessionProjectionDiagnostic,
    SessionProjectionProviderFailureRecord,
    SessionProjectionRebuildResult,
    SessionProjectionRecord,
    SessionProjectionRunRecord,
    SessionProjectionSessionRecord,
    SessionProjectionToolRecord,
} from './session-projection-types';
import { parseSqliteProjectionInput } from './sqlite-session-projection-input';
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
} from './sqlite-session-projection-rows';
import { replaceStatements } from './sqlite-session-projection-statements';

export type SqliteSessionProjectionStore = {
    replaceSessionProjection(input: {
        readonly sessionId: string;
        readonly records: readonly SessionProjectionRecord[];
        readonly diagnostics: readonly SessionProjectionDiagnostic[];
        readonly envelopes: readonly AgentEventEnvelope[];
    }): Promise<void>;
    listSessions(): Promise<readonly SessionProjectionSessionRecord[]>;
    getSession(sessionId: string): Promise<SessionProjectionSessionRecord | null>;
    getRuns(sessionId: string): Promise<readonly SessionProjectionRunRecord[]>;
    getApprovals(sessionId: string): Promise<readonly SessionProjectionApprovalRecord[]>;
    getTools(sessionId: string): Promise<readonly SessionProjectionToolRecord[]>;
    getProviderFailures(sessionId: string): Promise<readonly SessionProjectionProviderFailureRecord[]>;
    getDiagnostics(sessionId: string): Promise<readonly SessionProjectionDiagnostic[]>;
    close(): void;
};

export async function openSqliteSessionProjectionStore(input: {
    readonly dataDir?: string;
}): Promise<SqliteSessionProjectionStore> {
    const runtime = await openMissionControlDb({
        ...(input.dataDir !== undefined ? { dataDir: input.dataDir } : {}),
    });
    return createSqliteSessionProjectionStore(runtime);
}

export function createSqliteSessionProjectionStore(runtime: LocalLibsqlDb): SqliteSessionProjectionStore {
    return new LibsqlSessionProjectionStore(runtime);
}

export async function projectSessionEventsToSqlite(input: {
    readonly store: SqliteSessionProjectionStore;
    readonly sessionId: string;
    readonly sourcePath: string;
    readonly envelopes: readonly unknown[];
}): Promise<SessionProjectionRebuildResult> {
    const parsed = parseSqliteProjectionInput(input);
    if (parsed.kind === 'diagnostic') {
        await input.store.replaceSessionProjection({
            sessionId: input.sessionId,
            records: [],
            diagnostics: [parsed.diagnostic],
            envelopes: [],
        });
        return { sessionId: input.sessionId, projectedRecords: 0, diagnostics: [parsed.diagnostic] };
    }
    const projection = deriveSessionProjectionRecordsFromEnvelopes({
        sessionId: input.sessionId,
        filePath: input.sourcePath,
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
        projectedRecords: projection.records.length,
        diagnostics: projection.diagnostics,
    };
}

class LibsqlSessionProjectionStore implements SqliteSessionProjectionStore {
    private readonly runtime: LocalLibsqlDb;

    constructor(runtime: LocalLibsqlDb) {
        this.runtime = runtime;
    }

    async replaceSessionProjection(input: {
        readonly sessionId: string;
        readonly records: readonly SessionProjectionRecord[];
        readonly diagnostics: readonly SessionProjectionDiagnostic[];
        readonly envelopes: readonly AgentEventEnvelope[];
    }): Promise<void> {
        await runLocalLibsqlWrite(this.runtime, async (client) => {
            await runLocalLibsqlClientTransaction(client, async () => {
                for (const statement of replaceStatements(input)) await client.execute(statement);
                await refreshSessionAwaitingFromPendingWaits({
                    client,
                    sessionId: input.sessionId,
                    now: input.envelopes.at(-1)?.event.timestamp ?? new Date(0).toISOString(),
                });
            });
        });
    }

    async listSessions(): Promise<readonly SessionProjectionSessionRecord[]> {
        const result = await this.runtime.client.execute(sessionSelectSql('ORDER BY s.updated_at, s.session_id'));
        return result.rows.map((row) => sessionRowSchema.parse(row)).map(sessionRecordFromRow);
    }

    async getSession(sessionId: string): Promise<SessionProjectionSessionRecord | null> {
        const result = await this.runtime.client.execute({
            sql: sessionSelectSql('WHERE s.session_id = ?'),
            args: [sessionId],
        });
        const row = result.rows[0];
        return row === undefined ? null : sessionRecordFromRow(sessionRowSchema.parse(row));
    }

    async getRuns(sessionId: string): Promise<readonly SessionProjectionRunRecord[]> {
        const result = await this.runtime.client.execute({
            sql: 'SELECT * FROM session_projection_runs WHERE session_id = ? ORDER BY sequence, event_id',
            args: [sessionId],
        });
        return result.rows.map((row) => runRecordFromRow(runRowSchema.parse(row)));
    }

    async getApprovals(sessionId: string): Promise<readonly SessionProjectionApprovalRecord[]> {
        const result = await this.runtime.client.execute({
            sql: 'SELECT * FROM approvals WHERE session_id = ? ORDER BY approval_id',
            args: [sessionId],
        });
        return result.rows.map((row) => approvalRecordFromRow(approvalRowSchema.parse(row)));
    }

    async getTools(sessionId: string): Promise<readonly SessionProjectionToolRecord[]> {
        const result = await this.runtime.client.execute({
            sql: 'SELECT * FROM tool_calls WHERE session_id = ? ORDER BY tool_call_id',
            args: [sessionId],
        });
        return result.rows.map((row) => toolRecordFromRow(toolRowSchema.parse(row)));
    }

    async getProviderFailures(sessionId: string): Promise<readonly SessionProjectionProviderFailureRecord[]> {
        const result = await this.runtime.client.execute({
            sql: 'SELECT * FROM provider_failures WHERE session_id = ? ORDER BY event_id',
            args: [sessionId],
        });
        return result.rows.map((row) => providerFailureRecordFromRow(providerFailureRowSchema.parse(row)));
    }

    async getDiagnostics(sessionId: string): Promise<readonly SessionProjectionDiagnostic[]> {
        const result = await this.runtime.client.execute({
            sql: `
                SELECT * FROM session_projection_diagnostics
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
               s.parent_session_id, s.title, s.category, s.agent_name,
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
