import type { Client } from '@libsql/client';
import { type LocalLibsqlWriteTarget, runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import { checksumFor, type FoundLegacySource } from './session-import-files.js';
import type { ImportAccumulator } from './session-import-sources.js';
import {
    hasLegacyImport,
    type LegacySessionImportDiagnostic,
    type LegacySessionImportLedgerEntry,
    recordLegacyImport,
} from './session-import-sql.js';

export async function skipImported(input: {
    readonly client: Client;
    readonly source: FoundLegacySource;
    readonly acc: ImportAccumulator;
}): Promise<boolean> {
    if (
        !(await hasLegacyImport({
            client: input.client,
            sourcePath: input.source.sourcePath,
            checksum: input.source.checksum,
        }))
    ) {
        return false;
    }
    input.acc.skippedSourceCount += 1;
    return true;
}

export async function recordImport(input: {
    readonly writeTarget: LocalLibsqlWriteTarget;
    readonly source: FoundLegacySource;
    readonly importedAt: string;
    readonly importedEventCount?: number;
    readonly diagnostics?: readonly LegacySessionImportDiagnostic[];
}): Promise<void> {
    const entry: LegacySessionImportLedgerEntry = {
        importId: checksumFor(`${input.source.sourceKind}\0${input.source.sourcePath}\0${input.source.checksum}`),
        sourcePath: input.source.sourcePath,
        sourceKind: input.source.sourceKind,
        checksum: input.source.checksum,
        importedEventCount: input.importedEventCount ?? 0,
        importedAt: input.importedAt,
        diagnostics: input.diagnostics ?? [],
    };
    await runLocalLibsqlWrite(input.writeTarget, (client) => recordLegacyImport({ client, entry }));
}
