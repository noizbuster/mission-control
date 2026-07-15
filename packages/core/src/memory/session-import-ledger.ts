import type { Client } from '@libsql/client';
import { type LocalLibsqlWriteTarget, runLocalLibsqlWrite } from '../db/local-libsql-db';
import { checksumFor, type FoundLegacySource } from './session-import-files';
import type { ImportAccumulator } from './session-import-sources';
import {
    hasLegacyImport,
    type LegacySessionImportDiagnostic,
    type LegacySessionImportLedgerEntry,
    recordLegacyImport,
} from './session-import-sql';

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
}): Promise<boolean> {
    const entry: LegacySessionImportLedgerEntry = {
        importId: legacyImportIdFor(input.source),
        sourcePath: input.source.sourcePath,
        sourceKind: input.source.sourceKind,
        checksum: input.source.checksum,
        importedEventCount: input.importedEventCount ?? 0,
        importedAt: input.importedAt,
        diagnostics: input.diagnostics ?? [],
    };
    return runLocalLibsqlWrite(input.writeTarget, (client) => recordLegacyImport({ client, entry }));
}

export function legacyImportIdFor(source: FoundLegacySource): string {
    return checksumFor(`${source.sourceKind}\0${source.sourcePath}\0${source.checksum}`);
}
