import type { Client } from '@libsql/client';
import { z } from 'zod';
import { desktopApprovalEffectsTableSql } from './local-libsql-schema-projections.js';
import { runLocalLibsqlClientTransaction } from './local-libsql-transaction.js';

const legacyColumns = [
    'session_id',
    'approval_id',
    'run_id',
    'tool_call_id',
    'tool_name',
    'arguments_json',
    'workspace_root',
    'state',
    'requested_at',
    'settled_at',
] as const;

const currentColumns = [
    'session_id',
    'approval_id',
    'run_id',
    'tool_call_id',
    'tool_name',
    'arguments_json',
    'workspace_root',
    'state',
    'execution_token',
    'lease_expires_at',
    'outcome',
    'requested_at',
    'executing_at',
    'settled_at',
    'unknown_at',
    'resolved_at',
] as const;

const tableColumnSchema = z.object({ name: z.string() });

export class DesktopApprovalEffectSchemaError extends Error {
    readonly name = 'DesktopApprovalEffectSchemaError';
    readonly columns: readonly string[];

    constructor(columns: readonly string[]) {
        super(`Unexpected desktop_approval_effects columns: ${columns.join(',')}`);
        this.columns = columns;
    }
}

export async function rebuildLegacyDesktopApprovalEffects(client: Client): Promise<void> {
    const result = await client.execute("PRAGMA table_info('desktop_approval_effects')");
    const columns = result.rows.map((row) => tableColumnSchema.parse(row).name);
    if (sameColumns(columns, currentColumns)) return;
    if (!sameColumns(columns, legacyColumns)) throw new DesktopApprovalEffectSchemaError(columns);

    await runLocalLibsqlClientTransaction(client, async () => {
        await client.execute('ALTER TABLE desktop_approval_effects RENAME TO desktop_approval_effects_legacy');
        await client.execute(desktopApprovalEffectsTableSql);
        await client.execute(`
            INSERT INTO desktop_approval_effects (
                session_id, approval_id, run_id, tool_call_id, tool_name, arguments_json, workspace_root,
                state, execution_token, lease_expires_at, outcome, requested_at, executing_at,
                settled_at, unknown_at, resolved_at
            )
            SELECT
                legacy.session_id,
                legacy.approval_id,
                legacy.run_id,
                legacy.tool_call_id,
                legacy.tool_name,
                legacy.arguments_json,
                legacy.workspace_root,
                CASE legacy.state WHEN 'pending' THEN 'pending' ELSE 'unknown' END,
                CASE legacy.state WHEN 'pending' THEN NULL
                    ELSE 'legacy:' || legacy.session_id || ':' || legacy.approval_id END,
                CASE legacy.state WHEN 'pending' THEN NULL ELSE COALESCE(legacy.settled_at, legacy.requested_at) END,
                NULL,
                legacy.requested_at,
                CASE legacy.state WHEN 'pending' THEN NULL ELSE COALESCE(legacy.settled_at, legacy.requested_at) END,
                NULL,
                CASE legacy.state WHEN 'pending' THEN NULL ELSE COALESCE(legacy.settled_at, legacy.requested_at) END,
                NULL
            FROM desktop_approval_effects_legacy AS legacy
            INNER JOIN sessions ON sessions.session_id = legacy.session_id
            WHERE legacy.state IN ('pending', 'settled')
        `);
        await client.execute('DROP TABLE desktop_approval_effects_legacy');
        await client.execute(
            'CREATE INDEX IF NOT EXISTS desktop_approval_effects_state_idx ON desktop_approval_effects (state)',
        );
    });
}

function sameColumns(actual: readonly string[], expected: readonly string[]): boolean {
    return actual.length === expected.length && actual.every((column, index) => column === expected[index]);
}
