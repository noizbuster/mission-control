import type { Client } from '@libsql/client';
import { runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import {
    createJsonlSessionEventRecord,
    createJsonlSessionLogHeader,
    serializeJsonlRecord,
} from './jsonl-session-records.js';
import { markSessionExported, readExportEnvelopes } from './session-import-event-sql.js';
import { jsonlSourcePaths, runSourcePaths } from './session-import-files.js';
import { type ImportAccumulator, importJsonlSource, importRunSource } from './session-import-sources.js';
import { ensureLegacySessionImportTables, type LegacySessionImportDiagnostic } from './session-import-sql.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export { listLegacySessionImportLedger } from './session-import-sql.js';

export type LegacySessionImportResult = {
    readonly importedEventCount: number;
    readonly importedRunCount: number;
    readonly skippedSourceCount: number;
    readonly diagnostics: readonly LegacySessionImportDiagnostic[];
};

export type LegacySessionExportResult = {
    readonly sessionId: string;
    readonly filePath: string;
    readonly exportedEventCount: number;
};

export async function importLegacySessionCompatibilityWindow(input: {
    readonly client: Client;
    readonly url: string;
    readonly dataDir: string;
    readonly omoRoot?: string;
    readonly includeRunSources?: boolean;
    readonly now?: () => string;
}): Promise<LegacySessionImportResult> {
    await runLocalLibsqlWrite(input, ensureLegacySessionImportTables);
    const acc: ImportAccumulator = {
        importedEventCount: 0,
        importedRunCount: 0,
        skippedSourceCount: 0,
        diagnostics: [],
    };
    const now = input.now ?? (() => new Date().toISOString());
    const omoRoot = input.omoRoot ?? join(input.dataDir, '.omo');

    for (const sourcePath of await jsonlSourcePaths(input.dataDir)) {
        await importJsonlSource({ writeTarget: input, sourcePath, now, acc });
    }
    if (input.includeRunSources ?? true) {
        for (const sourcePath of await runSourcePaths(omoRoot)) {
            await importRunSource({ writeTarget: input, sourcePath, now, acc });
        }
    }

    return {
        importedEventCount: acc.importedEventCount,
        importedRunCount: acc.importedRunCount,
        skippedSourceCount: acc.skippedSourceCount,
        diagnostics: acc.diagnostics,
    };
}

export async function exportLegacySessionJsonl(input: {
    readonly client: Client;
    readonly url: string;
    readonly sessionId: string;
    readonly outputDir: string;
    readonly now?: () => string;
}): Promise<LegacySessionExportResult> {
    const now = input.now ?? (() => new Date().toISOString());
    const envelopes = await readExportEnvelopes({ client: input.client, sessionId: input.sessionId });
    await mkdir(input.outputDir, { recursive: true });
    const filePath = join(input.outputDir, `${input.sessionId}.jsonl`);
    const createdAt = envelopes.at(0)?.createdAt ?? now();
    const contents = [
        serializeJsonlRecord(createJsonlSessionLogHeader({ sessionId: input.sessionId, createdAt })),
        ...envelopes.map((envelope) => serializeJsonlRecord(createJsonlSessionEventRecord(envelope))),
    ].join('');
    await writeFile(filePath, contents, 'utf8');
    await markSessionExported({ ...input, exportedAt: now() });
    return { sessionId: input.sessionId, filePath, exportedEventCount: envelopes.length };
}
