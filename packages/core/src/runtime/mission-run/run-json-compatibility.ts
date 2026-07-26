import { type Run, RunSchema } from '@mission-control/protocol';
import { compatibilityJsonFilePath, listCompatibilityJsonRecordIds } from '../../persistence/json-compatibility-file';
import { McPersistenceError } from '../../persistence/paths';
import { mapJsonCompatibilityFileError, readCompatibilityRecord } from './compat-record-reader';
import { runWithoutSessionOwnerAuthority } from './run-session-owner-authority';

const RUNS_DIR = 'runs';

export class RunStoreError extends McPersistenceError {
    constructor(message: string, code: string, path?: string, cause?: unknown) {
        super(message, code, path, cause);
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
    return readCompatibilityRecord<Run>({
        root,
        dir: RUNS_DIR,
        id: runId,
        filePath: compatibleRunFilePath(root, runId),
        schema: RunSchema,
        toError: (message, code, path, cause) => new RunStoreError(message, code, path, cause),
        corruptCode: 'legacy_run_corrupt',
        entityNoun: 'Run',
        mapReadError: (error) => mapCompatibilityError(error, runId),
        transform: runWithoutSessionOwnerAuthority,
    });
}

function mapCompatibilityError(error: unknown, runId: string): RunStoreError {
    return mapJsonCompatibilityFileError<RunStoreError>(error, runId, {
        toError: (message, code, path, cause) => new RunStoreError(message, code, path, cause),
        codes: {
            invalidId: 'invalid_run_id',
            notFound: 'run_missing',
            unsafeSource: 'legacy_run_unsafe_source',
            readFailed: 'legacy_run_read_failed',
        },
        entityNoun: 'Run',
    });
}
