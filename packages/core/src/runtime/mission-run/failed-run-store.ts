import { type Run, RunSchema } from '@mission-control/protocol';
import { ZodError } from 'zod';
import { omoFilePath } from '../../persistence/paths.js';
import { listRunsFromDb, writeRunToDb } from './mission-run-db.js';
import { readdir, readFile } from 'node:fs/promises';

const RUNS_DIR = 'runs';
const JSON_EXTENSION = '.json';

export async function findMostRecentFailedRunRecord(root: string): Promise<Run | undefined> {
    let latest = latestFailedRun(undefined, await listRunsFromDb(root));
    const dir = omoFilePath(root, RUNS_DIR);
    let entries: readonly string[];
    try {
        entries = await readdir(dir);
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            return latest;
        }
        throw error;
    }
    for (const entry of entries) {
        if (!entry.endsWith(JSON_EXTENSION)) continue;
        const run = await readLegacyRun(root, entry.slice(0, -JSON_EXTENSION.length));
        if (run === undefined || run.status !== 'failed') continue;
        await writeRunToDb(root, run);
        if (latest === undefined || compareEndedAt(run, latest) > 0) {
            latest = run;
        }
    }
    return latest;
}

function latestFailedRun(current: Run | undefined, runs: readonly Run[]): Run | undefined {
    let latest = current;
    for (const run of runs) {
        if (run.status !== 'failed') {
            continue;
        }
        if (latest === undefined || compareEndedAt(run, latest) > 0) {
            latest = run;
        }
    }
    return latest;
}

async function readLegacyRun(root: string, runId: string): Promise<Run | undefined> {
    const filePath = omoFilePath(root, RUNS_DIR, `${runId}.json`);
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            return undefined;
        }
        throw error;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch (error: unknown) {
        if (error instanceof SyntaxError) {
            return undefined;
        }
        throw error;
    }
    try {
        return RunSchema.parse(parsed);
    } catch (error: unknown) {
        if (error instanceof ZodError) {
            return undefined;
        }
        throw error;
    }
}

function compareEndedAt(a: Run, b: Run): number {
    const aTime = a.endedAt ?? '';
    const bTime = b.endedAt ?? '';
    if (aTime < bTime) return -1;
    if (aTime > bTime) return 1;
    return 0;
}

function isErrorCode(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === code
    );
}
