import { type LocalLibsqlWriteTarget, runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import { JsonlSessionEventStoreError } from './jsonl-errors.js';
import { type ParsedJsonlSessionLog, parseJsonlSessionLog } from './jsonl-session-records.js';
import { importJsonlSessionRows } from './session-import-event-sql.js';
import { readLegacySource } from './session-import-files.js';
import { recordImport, skipImported } from './session-import-ledger.js';
import { jsonlImportDiagnostic, parseLegacyRun, sourceImportDiagnostic } from './session-import-parse.js';
import { importMissionRunRow } from './session-import-run-sql.js';
import type { LegacySessionImportDiagnostic } from './session-import-sql.js';
import { basename } from 'node:path';

export type ImportAccumulator = {
    importedEventCount: number;
    importedRunCount: number;
    skippedSourceCount: number;
    diagnostics: LegacySessionImportDiagnostic[];
};

export async function importJsonlSource(input: {
    readonly writeTarget: LocalLibsqlWriteTarget;
    readonly sourcePath: string;
    readonly now: () => string;
    readonly acc: ImportAccumulator;
}): Promise<void> {
    const source = await readLegacySource(input.sourcePath, 'jsonl');
    if (source.kind === 'missing') {
        return;
    }
    if (await skipImported({ client: input.writeTarget.client, source, acc: input.acc })) {
        return;
    }
    const sessionId = basename(input.sourcePath, '.jsonl');
    const importedAt = input.now();
    let parsed: ParsedJsonlSessionLog;
    try {
        parsed = parseJsonlSessionLog({ contents: source.contents, filePath: input.sourcePath, sessionId });
    } catch (error: unknown) {
        if (!(error instanceof JsonlSessionEventStoreError)) {
            throw error;
        }
        const diagnostic = jsonlImportDiagnostic({ error, sourcePath: input.sourcePath, sessionId });
        input.acc.diagnostics.push(diagnostic);
        await recordImport({ writeTarget: input.writeTarget, source, importedAt, diagnostics: [diagnostic] });
        return;
    }
    await importJsonlSessionRows({
        ...input.writeTarget,
        sessionId,
        sourcePath: input.sourcePath,
        createdAt: parsed.header.createdAt,
        importedAt,
        envelopes: parsed.envelopes,
    });
    input.acc.importedEventCount += parsed.envelopes.length;
    await recordImport({
        writeTarget: input.writeTarget,
        source,
        importedAt,
        importedEventCount: parsed.envelopes.length,
    });
}

export async function importRunSource(input: {
    readonly writeTarget: LocalLibsqlWriteTarget;
    readonly sourcePath: string;
    readonly now: () => string;
    readonly acc: ImportAccumulator;
}): Promise<void> {
    const source = await readLegacySource(input.sourcePath, 'mission_run');
    if (
        source.kind === 'missing' ||
        (await skipImported({ client: input.writeTarget.client, source, acc: input.acc }))
    ) {
        return;
    }
    const importedAt = input.now();
    const parsed = parseLegacyRun(source.contents);
    if (parsed.kind === 'ok') {
        await runLocalLibsqlWrite(input.writeTarget, (client) =>
            importMissionRunRow({ client, run: parsed.run, importedAt }),
        );
        input.acc.importedRunCount += 1;
        await recordImport({ writeTarget: input.writeTarget, source, importedAt });
        return;
    }
    const diagnostic = sourceImportDiagnostic({
        source,
        code: 'invalid_run',
        message: parsed.message,
        runId: basename(input.sourcePath, '.json'),
    });
    input.acc.diagnostics.push(diagnostic);
    await recordImport({ writeTarget: input.writeTarget, source, importedAt, diagnostics: [diagnostic] });
}
