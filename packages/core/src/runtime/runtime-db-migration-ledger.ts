import type { Client } from '@libsql/client';
import { z } from 'zod';
import type { RuntimeDbMigrationTableManifest } from './runtime-db-migration-copy.js';
import type { LegacyRuntimeSource } from './runtime-db-migration-sources.js';
import { createHash } from 'node:crypto';

const MANIFEST_VERSION = 1;

const ledgerRowSchema = z.object({
    migration_id: z.string(),
    legacy_db_identity: z.string(),
    source_root_file_url: z.string(),
    source_db_file_url: z.string().nullable(),
    source_manifest_sha256: z.string(),
    copied_tables_json: z.string(),
    legacy_runs_json: z.string(),
    completed_at: z.string(),
});

export type RuntimeDbMigrationLedgerRow = z.infer<typeof ledgerRowSchema>;
export type ExpectedRuntimeDbMigrationLedgerRow = Omit<RuntimeDbMigrationLedgerRow, 'completed_at'>;

export function createExpectedMigrationLedger(
    source: LegacyRuntimeSource,
    tables: readonly RuntimeDbMigrationTableManifest[],
): ExpectedRuntimeDbMigrationLedgerRow {
    const legacyRuns = source.runs.map((run) => ({ path: run.fileUrl, checksum: run.checksum }));
    const copiedTablesJson = JSON.stringify(tables);
    const legacyRunsJson = JSON.stringify(legacyRuns);
    const manifest = JSON.stringify({
        version: MANIFEST_VERSION,
        sourceDbFileUrl: source.database?.fileUrl ?? null,
        tables,
        legacyRuns,
    });
    return {
        migration_id: source.migrationId,
        legacy_db_identity: source.legacyDbIdentity,
        source_root_file_url: source.rootFileUrl,
        source_db_file_url: source.database?.fileUrl ?? null,
        source_manifest_sha256: sha256(manifest),
        copied_tables_json: copiedTablesJson,
        legacy_runs_json: legacyRunsJson,
    };
}

export async function readMigrationLedgerRow(
    client: Client,
    migrationId: string,
): Promise<RuntimeDbMigrationLedgerRow | undefined> {
    const result = await client.execute({
        sql: 'SELECT * FROM runtime_db_migration_ledger WHERE migration_id = ?',
        args: [migrationId],
    });
    const row = result.rows[0];
    return row === undefined ? undefined : ledgerRowSchema.parse(row);
}

export function migrationLedgerMatches(
    existing: RuntimeDbMigrationLedgerRow,
    expected: ExpectedRuntimeDbMigrationLedgerRow,
): boolean {
    return (
        existing.migration_id === expected.migration_id &&
        existing.legacy_db_identity === expected.legacy_db_identity &&
        existing.source_root_file_url === expected.source_root_file_url &&
        existing.source_db_file_url === expected.source_db_file_url &&
        existing.source_manifest_sha256 === expected.source_manifest_sha256 &&
        existing.copied_tables_json === expected.copied_tables_json &&
        existing.legacy_runs_json === expected.legacy_runs_json
    );
}

export async function insertMigrationLedgerRow(client: Client, row: RuntimeDbMigrationLedgerRow): Promise<void> {
    await client.execute({
        sql: 'INSERT INTO runtime_db_migration_ledger (migration_id, legacy_db_identity, source_root_file_url, source_db_file_url, source_manifest_sha256, copied_tables_json, legacy_runs_json, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        args: [
            row.migration_id,
            row.legacy_db_identity,
            row.source_root_file_url,
            row.source_db_file_url,
            row.source_manifest_sha256,
            row.copied_tables_json,
            row.legacy_runs_json,
            row.completed_at,
        ],
    });
}

function sha256(value: string): string {
    return createHash('sha256').update(value, 'utf8').digest('hex');
}
