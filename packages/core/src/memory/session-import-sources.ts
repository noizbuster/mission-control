import { ZodError, type z } from 'zod';
import { type LocalLibsqlWriteTarget, runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import { JsonlSessionEventStoreError } from './jsonl-errors.js';
import { type ParsedJsonlSessionLog, parseJsonlSessionLog } from './jsonl-session-records.js';
import { importJsonlSessionRows, importSessionIndexRecord } from './session-import-event-sql.js';
import { readLegacySource } from './session-import-files.js';
import { recordImport, skipImported } from './session-import-ledger.js';
import {
    jsonlImportDiagnostic,
    parseLegacyRun,
    sessionIndexSessionRecord,
    sourceImportDiagnostic,
} from './session-import-parse.js';
import { importMissionRunRow } from './session-import-run-sql.js';
import type { LegacySessionImportDiagnostic } from './session-import-sql.js';
import { SessionIndexFileSchema } from './session-index-file-format.js';
import { basename } from 'node:path';

type ParsedSessionIndexFile = z.infer<typeof SessionIndexFileSchema>;

export type ImportAccumulator = {
    importedEventCount: number;
    importedSessionIndexRecordCount: number;
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

export async function importSessionIndexSource(input: {
    readonly writeTarget: LocalLibsqlWriteTarget;
    readonly sourcePath: string;
    readonly now: () => string;
    readonly acc: ImportAccumulator;
}): Promise<void> {
    const source = await readLegacySource(input.sourcePath, 'session_index');
    if (
        source.kind === 'missing' ||
        (await skipImported({ client: input.writeTarget.client, source, acc: input.acc }))
    ) {
        return;
    }
    const importedAt = input.now();
    const parsed = parseSessionIndexFile(source.contents);
    if (parsed.kind === 'invalid') {
        const diagnostic = sourceImportDiagnostic({
            source,
            code: 'invalid_session_index',
            message: parsed.message,
        });
        input.acc.diagnostics.push(diagnostic);
        await recordImport({ writeTarget: input.writeTarget, source, importedAt, diagnostics: [diagnostic] });
        return;
    }
    const sessionRecords = parsed.file.records.flatMap((record) => sessionIndexSessionRecord(record));
    for (const record of sessionRecords) {
        await importSessionIndexRecord({ ...input.writeTarget, record, importedAt });
    }
    input.acc.importedSessionIndexRecordCount += sessionRecords.length;
    await recordImport({ writeTarget: input.writeTarget, source, importedAt });
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

function parseSessionIndexFile(
    contents: string,
):
    | { readonly kind: 'ok'; readonly file: ParsedSessionIndexFile }
    | { readonly kind: 'invalid'; readonly message: string } {
    try {
        return { kind: 'ok', file: SessionIndexFileSchema.parse(JSON.parse(contents)) };
    } catch (error: unknown) {
        if (error instanceof SyntaxError || error instanceof ZodError) {
            return { kind: 'invalid', message: error.message };
        }
        throw error;
    }
}
