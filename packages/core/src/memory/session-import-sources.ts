import { type LocalLibsqlWriteTarget, runLocalLibsqlWrite } from '../db/local-libsql-db.js';
import {
    createObservabilityRedactor,
    type ObservabilityRedactor,
    redactAgentEventEnvelopeForObservability,
} from '../providers/observability-redactor.js';
import { JsonlSessionEventStoreError } from './jsonl-errors.js';
import { type ParsedJsonlSessionLog, parseJsonlSessionLog } from './jsonl-session-records.js';
import { importJsonlSessionRows } from './session-import-event-sql.js';
import { readLegacySource } from './session-import-files.js';
import { legacyImportIdFor, recordImport, skipImported } from './session-import-ledger.js';
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
    readonly observabilityRedactor?: ObservabilityRedactor;
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
        const recorded = await recordImport({
            writeTarget: input.writeTarget,
            source,
            importedAt,
            diagnostics: [diagnostic],
        });
        if (recorded) input.acc.diagnostics.push(diagnostic);
        else input.acc.skippedSourceCount += 1;
        return;
    }
    const redactor = input.observabilityRedactor ?? createObservabilityRedactor();
    const observableEnvelopes = parsed.envelopes.map((envelope) =>
        redactAgentEventEnvelopeForObservability(envelope, redactor),
    );
    const result = await importJsonlSessionRows({
        ...input.writeTarget,
        sessionId,
        sourcePath: input.sourcePath,
        sourceChecksum: source.checksum,
        importId: legacyImportIdFor(source),
        createdAt: parsed.header.createdAt,
        importedAt,
        envelopes: observableEnvelopes,
    });
    switch (result.kind) {
        case 'source_skipped':
            input.acc.skippedSourceCount += 1;
            return;
        case 'imported':
            input.acc.importedEventCount += result.insertedEventCount;
            return;
    }
}

export async function importRunSource(input: {
    readonly writeTarget: LocalLibsqlWriteTarget;
    readonly sourcePath: string;
    readonly now: () => string;
    readonly acc: ImportAccumulator;
    readonly observabilityRedactor?: ObservabilityRedactor;
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
        const diagnostics = parsed.hadSessionOwnerAuthority
            ? [
                  sourceImportDiagnostic({
                      source,
                      code: 'session_owner_stripped',
                      message: 'Imported Run session owner authority was stripped',
                      runId: parsed.run.id,
                  }),
              ]
            : [];
        const imported = await runLocalLibsqlWrite(input.writeTarget, (client) =>
            importMissionRunRow({
                client,
                run: parsed.run,
                importedAt,
                ...(input.observabilityRedactor !== undefined
                    ? { observabilityRedactor: input.observabilityRedactor }
                    : {}),
            }),
        );
        if (imported) input.acc.importedRunCount += 1;
        const recorded = await recordImport({
            writeTarget: input.writeTarget,
            source,
            importedAt,
            ...(diagnostics.length > 0 ? { diagnostics } : {}),
        });
        if (recorded) input.acc.diagnostics.push(...diagnostics);
        else input.acc.skippedSourceCount += 1;
        return;
    }
    const diagnostic = sourceImportDiagnostic({
        source,
        code: 'invalid_run',
        message: parsed.message,
        runId: basename(input.sourcePath, '.json'),
    });
    const recorded = await recordImport({
        writeTarget: input.writeTarget,
        source,
        importedAt,
        diagnostics: [diagnostic],
    });
    if (recorded) input.acc.diagnostics.push(diagnostic);
    else input.acc.skippedSourceCount += 1;
}
