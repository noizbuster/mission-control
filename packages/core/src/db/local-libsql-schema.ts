import type { Client, InStatement } from '@libsql/client';
import { agentJobRelationSchemaSql } from './local-libsql-schema-agent-jobs';
import { rebuildLegacyDesktopApprovalEffects } from './local-libsql-schema-approval-effects';
import { sessionEventStoreSchemaSql } from './local-libsql-schema-events';
import { memoryEntriesSchemaSql } from './local-libsql-schema-memory';
import { sessionProjectionSchemaSql } from './local-libsql-schema-projections';
import { runtimePersistenceSchemaSql } from './local-libsql-schema-runtime';
import { sessionControlSchemaSql } from './local-libsql-schema-session-control';
import { ensureSessionIdentityColumns } from './local-libsql-schema-session-identity';

export const localDbSchemaSql = [
    ...memoryEntriesSchemaSql,
    ...runtimePersistenceSchemaSql,
    ...sessionControlSchemaSql,
    ...sessionEventStoreSchemaSql,
    ...sessionProjectionSchemaSql,
    ...agentJobRelationSchemaSql,
] as const;

export async function ensureLocalDbSchema(client: Client): Promise<void> {
    const statements: InStatement[] = localDbSchemaSql.map((sql) => ({ sql }));
    await client.batch(statements, 'write');
    await rebuildLegacyDesktopApprovalEffects(client);
    await migrateLegacyProjectionTables(client);
    await migrateToolCallsToSessionScopedPrimaryKey(client);
    await ensureSessionIdentityColumns(client);
}

/**
 * Migrate `tool_calls` from the legacy GLOBAL primary key (`tool_call_id` alone) to the
 * session-scoped composite primary key `(session_id, tool_call_id)`. The global PK made
 * cross-session tool_call_id reuse (deterministic fixtures, provider id reuse) collide on
 * INSERT even though the projection's pre-INSERT DELETE only clears the current session's
 * rows. Detection is idempotent: if the table already has the composite PK, the legacy-PK
 * `LIKE` check returns no rows and the migration is a no-op.
 */
async function migrateToolCallsToSessionScopedPrimaryKey(client: Client): Promise<void> {
    if (!(await tableExists(client, 'tool_calls'))) {
        return;
    }
    const legacyPrimaryKey = await client.execute({
        sql: `SELECT 1 FROM sqlite_master
              WHERE type = 'table' AND name = 'tool_calls'
                AND sql LIKE '%tool_call_id TEXT PRIMARY KEY NOT NULL%' LIMIT 1`,
    });
    if (legacyPrimaryKey.rows.length === 0) {
        return;
    }
    await client.batch(
        [
            { sql: 'DROP INDEX IF EXISTS tool_calls_session_status_idx' },
            { sql: 'DROP INDEX IF EXISTS tool_calls_run_idx' },
            { sql: 'DROP INDEX IF EXISTS tool_calls_approval_idx' },
            { sql: 'ALTER TABLE tool_calls RENAME TO tool_calls_legacy_pk' },
            {
                sql: `CREATE TABLE tool_calls (
                    tool_call_id TEXT NOT NULL,
                    session_id TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
                    run_id TEXT,
                    approval_id TEXT,
                    name TEXT NOT NULL,
                    status TEXT NOT NULL,
                    arguments_json TEXT,
                    result_json TEXT,
                    started_at TEXT,
                    completed_at TEXT,
                    failed_at TEXT,
                    last_message TEXT,
                    error_json TEXT,
                    applied_files_json TEXT,
                    PRIMARY KEY (session_id, tool_call_id)
                )`,
            },
            {
                sql: `INSERT OR IGNORE INTO tool_calls (
                    tool_call_id, session_id, run_id, approval_id, name, status,
                    arguments_json, result_json, started_at, completed_at, failed_at,
                    last_message, error_json, applied_files_json
                )
                SELECT
                    tool_call_id, session_id, run_id, approval_id, name, status,
                    arguments_json, result_json, started_at, completed_at, failed_at,
                    last_message, error_json, applied_files_json
                FROM tool_calls_legacy_pk`,
            },
            { sql: 'DROP TABLE tool_calls_legacy_pk' },
            { sql: 'CREATE INDEX IF NOT EXISTS tool_calls_session_status_idx ON tool_calls (session_id, status)' },
            { sql: 'CREATE INDEX IF NOT EXISTS tool_calls_run_idx ON tool_calls (run_id)' },
            { sql: 'CREATE INDEX IF NOT EXISTS tool_calls_approval_idx ON tool_calls (approval_id)' },
        ],
        'write',
    );
}

async function migrateLegacyProjectionTables(client: Client): Promise<void> {
    await migrateLegacyProjectionTable(client, {
        legacyTable: 'session_index_runs',
        currentTable: 'session_projection_runs',
        columns: [
            'session_id',
            'event_id',
            'sequence',
            'timestamp',
            'event_type',
            'command',
            'state',
            'run_id',
            'input_id',
            'provider_turn_id',
            'reason',
            'error_code',
        ],
    });
    await migrateLegacyProjectionTable(client, {
        legacyTable: 'session_index_diagnostics',
        currentTable: 'session_projection_diagnostics',
        columns: ['session_id', 'file_path', 'code', 'message', 'line_number'],
    });
}

async function migrateLegacyProjectionTable(
    client: Client,
    input: { readonly legacyTable: string; readonly currentTable: string; readonly columns: readonly string[] },
): Promise<void> {
    if (!(await tableExists(client, input.legacyTable))) {
        return;
    }
    const columns = input.columns.join(', ');
    await client.batch(
        [
            {
                sql: `INSERT OR IGNORE INTO ${input.currentTable} (${columns}) SELECT ${columns} FROM ${input.legacyTable}`,
            },
            { sql: `DROP TABLE ${input.legacyTable}` },
        ],
        'write',
    );
}

async function tableExists(client: Client, tableName: string): Promise<boolean> {
    const result = await client.execute({
        sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
        args: [tableName],
    });
    return result.rows.length > 0;
}
