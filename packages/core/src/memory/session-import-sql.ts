import type { Client } from '@libsql/client';
import { z } from 'zod';
import { legacyImportTableSql } from './session-import-schema.js';

export const legacySessionSourceKinds = ['jsonl', 'mission_run'] as const;
export type LegacySessionSourceKind = (typeof legacySessionSourceKinds)[number];

export const legacySessionImportDiagnosticCodes = ['corrupt_jsonl', 'invalid_run', 'read_failed'] as const;
export type LegacySessionImportDiagnosticCode = (typeof legacySessionImportDiagnosticCodes)[number];

export type LegacySessionImportDiagnostic = {
    readonly sourceKind: LegacySessionSourceKind;
    readonly sourcePath: string;
    readonly code: LegacySessionImportDiagnosticCode;
    readonly message: string;
    readonly sessionId?: string;
    readonly runId?: string;
    readonly lineNumber?: number;
};

export type LegacySessionImportLedgerEntry = {
    readonly importId: string;
    readonly sourcePath: string;
    readonly sourceKind: LegacySessionSourceKind;
    readonly checksum: string;
    readonly importedEventCount: number;
    readonly importedAt: string;
    readonly diagnostics: readonly LegacySessionImportDiagnostic[];
};

const ledgerRowSchema = z.object({
    import_id: z.string(),
    source_path: z.string(),
    source_kind: z.enum(legacySessionSourceKinds),
    checksum: z.string(),
    imported_event_count: z.coerce.number().int().nonnegative(),
    imported_at: z.string(),
    diagnostics_json: z.string().nullable(),
});

export async function ensureLegacySessionImportTables(client: Client): Promise<void> {
    for (const sql of legacyImportTableSql) {
        await client.execute(sql);
    }
}

export async function hasLegacyImport(input: {
    readonly client: Client;
    readonly sourcePath: string;
    readonly checksum: string;
}): Promise<boolean> {
    const result = await input.client.execute({
        sql: 'SELECT 1 FROM legacy_session_imports WHERE source_path = ? AND checksum = ? LIMIT 1',
        args: [input.sourcePath, input.checksum],
    });
    return result.rows.length > 0;
}

export async function listLegacySessionImportLedger(
    client: Client,
): Promise<readonly LegacySessionImportLedgerEntry[]> {
    await ensureLegacySessionImportTables(client);
    const result = await client.execute(
        'SELECT import_id, source_path, source_kind, checksum, imported_event_count, imported_at, diagnostics_json FROM legacy_session_imports ORDER BY source_path',
    );
    return result.rows.map((row) => ledgerEntryFromRow(ledgerRowSchema.parse(row)));
}

export async function recordLegacyImport(input: {
    readonly client: Client;
    readonly entry: LegacySessionImportLedgerEntry;
}): Promise<void> {
    await input.client.execute({
        sql: `
            INSERT OR IGNORE INTO legacy_session_imports
                (import_id, source_path, source_kind, checksum, imported_event_count, imported_at, diagnostics_json)
            VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        args: [
            input.entry.importId,
            input.entry.sourcePath,
            input.entry.sourceKind,
            input.entry.checksum,
            input.entry.importedEventCount,
            input.entry.importedAt,
            JSON.stringify(input.entry.diagnostics),
        ],
    });
}

function ledgerEntryFromRow(row: z.infer<typeof ledgerRowSchema>): LegacySessionImportLedgerEntry {
    return {
        importId: row.import_id,
        sourcePath: row.source_path,
        sourceKind: row.source_kind,
        checksum: row.checksum,
        importedEventCount: row.imported_event_count,
        importedAt: row.imported_at,
        diagnostics: z.array(z.custom<LegacySessionImportDiagnostic>()).parse(JSON.parse(row.diagnostics_json ?? '[]')),
    };
}
