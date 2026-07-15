import { type Run, RunSchema } from '@mission-control/protocol';
import { runWithoutSessionOwnerAuthority } from '../runtime/mission-run/run-session-owner-authority.js';
import { JsonlSessionEventStoreError } from './jsonl-errors.js';
import type { FoundLegacySource } from './session-import-files.js';
import type { LegacySessionImportDiagnostic } from './session-import-sql.js';

export function parseLegacyRun(
    contents: string,
):
    | { readonly kind: 'ok'; readonly run: Run; readonly hadSessionOwnerAuthority: boolean }
    | { readonly kind: 'invalid'; readonly message: string } {
    try {
        const parsed = RunSchema.safeParse(JSON.parse(contents));
        if (parsed.success) {
            return {
                kind: 'ok',
                run: runWithoutSessionOwnerAuthority(parsed.data),
                hadSessionOwnerAuthority: parsed.data.sessionRunId !== undefined,
            };
        }
        return { kind: 'invalid', message: parsed.error.issues.at(0)?.message ?? 'invalid run record' };
    } catch (error: unknown) {
        return { kind: 'invalid', message: error instanceof Error ? error.message : 'invalid run JSON' };
    }
}

export function jsonlImportDiagnostic(input: {
    readonly error: unknown;
    readonly sourcePath: string;
    readonly sessionId: string;
}): LegacySessionImportDiagnostic {
    if (input.error instanceof JsonlSessionEventStoreError) {
        return {
            sourceKind: 'jsonl',
            sourcePath: input.sourcePath,
            code: 'corrupt_jsonl',
            message: input.error.message,
            sessionId: input.sessionId,
            ...(input.error.lineNumber !== undefined ? { lineNumber: input.error.lineNumber } : {}),
        };
    }
    return {
        sourceKind: 'jsonl',
        sourcePath: input.sourcePath,
        code: 'corrupt_jsonl',
        message: input.error instanceof Error ? input.error.message : 'invalid JSONL session log',
        sessionId: input.sessionId,
    };
}

export function sourceImportDiagnostic(input: {
    readonly source: FoundLegacySource;
    readonly code: LegacySessionImportDiagnostic['code'];
    readonly message: string;
    readonly runId?: string;
}): LegacySessionImportDiagnostic {
    return {
        sourceKind: input.source.sourceKind,
        sourcePath: input.source.sourcePath,
        code: input.code,
        message: input.message,
        ...(input.runId !== undefined ? { runId: input.runId } : {}),
    };
}
