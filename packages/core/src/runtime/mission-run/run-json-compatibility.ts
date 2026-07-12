import { type Run, RunSchema } from '@mission-control/protocol';
import { ZodError } from 'zod';
import {
    compatibilityJsonFilePath,
    JsonCompatibilityFileError,
    listCompatibilityJsonRecordIds,
    readCompatibilityJsonFile,
} from '../../persistence/json-compatibility-file.js';
import { OmoPersistenceError } from '../../persistence/paths.js';

const RUNS_DIR = 'runs';

export class RunStoreError extends OmoPersistenceError {
    constructor(message: string, code: string, path?: string, cause?: unknown) {
        super(message, code, path, cause !== undefined ? { cause } : undefined);
        this.name = 'RunStoreError';
    }
}

export function compatibleRunFilePath(root: string, runId: string): string {
    try {
        return compatibilityJsonFilePath(root, RUNS_DIR, runId);
    } catch (error: unknown) {
        throw mapCompatibilityError(error, runId);
    }
}

export async function listCompatibleRunJsonRecords(
    root: string,
    excludedIds: ReadonlySet<string>,
): Promise<readonly Run[]> {
    let runIds: readonly string[];
    try {
        runIds = await listCompatibilityJsonRecordIds(root, RUNS_DIR);
    } catch (error: unknown) {
        throw mapCompatibilityError(error, RUNS_DIR);
    }
    const runs: Run[] = [];
    for (const runId of runIds) {
        if (excludedIds.has(runId)) continue;
        runs.push(await readCompatibleRunJsonRecord(root, runId));
    }
    return runs;
}

export async function readCompatibleRunJsonRecord(root: string, runId: string): Promise<Run> {
    const filePath = compatibleRunFilePath(root, runId);
    let contents: string;
    try {
        contents = await readCompatibilityJsonFile(root, RUNS_DIR, runId);
    } catch (error: unknown) {
        throw mapCompatibilityError(error, runId);
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch (error: unknown) {
        throw new RunStoreError(`Run ${runId} at ${filePath} is not valid JSON`, 'legacy_run_corrupt', filePath, error);
    }
    try {
        const run = RunSchema.parse(parsed);
        if (run.id !== runId) {
            throw new RunStoreError(`Run ${runId} at ${filePath} has a mismatched id`, 'legacy_run_corrupt', filePath);
        }
        return run;
    } catch (error: unknown) {
        if (!(error instanceof ZodError)) throw error;
        const firstIssue = error.issues[0]?.message ?? 'unknown schema issue';
        throw new RunStoreError(
            `Run ${runId} at ${filePath} failed validation: ${firstIssue}`,
            'legacy_run_corrupt',
            filePath,
            error,
        );
    }
}

function mapCompatibilityError(error: unknown, runId: string): RunStoreError {
    if (!(error instanceof JsonCompatibilityFileError)) {
        return new RunStoreError(`Failed to read Run ${runId}`, 'legacy_run_read_failed', undefined, error);
    }
    switch (error.code) {
        case 'invalid_id':
            return new RunStoreError(`Invalid Run id ${JSON.stringify(runId)}`, 'invalid_run_id', error.path, error);
        case 'not_found':
            return new RunStoreError(`Run ${runId} not found`, 'run_missing', error.path, error);
        case 'unsafe_source':
            return new RunStoreError(
                `Run ${runId} is not a safe regular file`,
                'legacy_run_unsafe_source',
                error.path,
                error,
            );
        case 'read_failed':
            return new RunStoreError(`Failed to read Run ${runId}`, 'legacy_run_read_failed', error.path, error);
    }
}
