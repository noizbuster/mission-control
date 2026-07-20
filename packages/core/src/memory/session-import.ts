import { type LocalLibsqlWriteTarget, runLocalLibsqlWrite } from '../db/local-libsql-db';
import { ensureLocalDbSchema } from '../db/local-libsql-schema';
import {
    createObservabilityRedactor,
    type ObservabilityRedactor,
    redactAgentEventEnvelopeForObservability,
} from '../providers/observability-redactor';
import {
    createJsonlSessionEventRecord,
    createJsonlSessionLogHeader,
    serializeJsonlRecord,
} from './jsonl-session-records';
import { markSessionExported, readExportEnvelopes } from './session-import-event-sql';
import { jsonlSourcePaths, runSourcePaths } from './session-import-files';
import { type ImportAccumulator, importJsonlSource, importRunSource } from './session-import-sources';
import type { LegacySessionImportDiagnostic } from './session-import-sql';
import { MC_DIR_NAME } from '../persistence/paths';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export type { LegacySessionImportConflictCode } from './session-import-conflict';
export { LegacySessionImportConflictError } from './session-import-conflict';
export { listLegacySessionImportLedger } from './session-import-sql';

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

export async function importLegacySessionCompatibilityWindow(
    input: LocalLibsqlWriteTarget & {
        readonly dataDir: string;
        readonly mcRoot?: string;
        readonly includeRunSources?: boolean;
        readonly now?: () => string;
        readonly observabilityRedactor?: ObservabilityRedactor;
    },
): Promise<LegacySessionImportResult> {
    await runLocalLibsqlWrite(input, ensureLocalDbSchema);
    const acc: ImportAccumulator = {
        importedEventCount: 0,
        importedRunCount: 0,
        skippedSourceCount: 0,
        diagnostics: [],
    };
    const now = input.now ?? (() => new Date().toISOString());
    const mcRoot = input.mcRoot ?? join(input.dataDir, MC_DIR_NAME);

    for (const sourcePath of await jsonlSourcePaths(input.dataDir)) {
        await importJsonlSource({
            writeTarget: input,
            sourcePath,
            now,
            acc,
            ...(input.observabilityRedactor !== undefined
                ? { observabilityRedactor: input.observabilityRedactor }
                : {}),
        });
    }
    if (input.includeRunSources ?? true) {
        for (const sourcePath of await runSourcePaths(mcRoot)) {
            await importRunSource({
                writeTarget: input,
                sourcePath,
                now,
                acc,
                ...(input.observabilityRedactor !== undefined
                    ? { observabilityRedactor: input.observabilityRedactor }
                    : {}),
            });
        }
    }

    return {
        importedEventCount: acc.importedEventCount,
        importedRunCount: acc.importedRunCount,
        skippedSourceCount: acc.skippedSourceCount,
        diagnostics: acc.diagnostics,
    };
}

export async function exportLegacySessionJsonl(
    input: LocalLibsqlWriteTarget & {
        readonly sessionId: string;
        readonly outputDir: string;
        readonly now?: () => string;
        readonly observabilityRedactor?: ObservabilityRedactor;
    },
): Promise<LegacySessionExportResult> {
    const now = input.now ?? (() => new Date().toISOString());
    const redactor = input.observabilityRedactor ?? createObservabilityRedactor();
    const envelopes = (await readExportEnvelopes({ client: input.client, sessionId: input.sessionId })).map(
        (envelope) => redactAgentEventEnvelopeForObservability(envelope, redactor),
    );
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
