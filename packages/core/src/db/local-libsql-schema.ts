import type { Client, InStatement } from '@libsql/client';
import { agentJobRelationSchemaSql } from './local-libsql-schema-agent-jobs.js';
import { sessionEventStoreSchemaSql } from './local-libsql-schema-events.js';
import { memoryEntriesSchemaSql } from './local-libsql-schema-memory.js';
import { sessionProjectionSchemaSql } from './local-libsql-schema-projections.js';
import { runtimePersistenceSchemaSql } from './local-libsql-schema-runtime.js';
import { sessionControlSchemaSql } from './local-libsql-schema-session-control.js';

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
    await migrateLegacyProjectionTables(client);
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
