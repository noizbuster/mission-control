/**
 * Persists {@link BackgroundJobHandle} instances to disk so AsyncJobManager
 * background jobs survive process restarts. Each job is stored as a single JSON
 * file at `<jobsDir>/<jobId>.json`. Writes are atomic (temp-file-then-rename)
 * following the `.omo/` persistence convention from `boulder-store.ts`, so
 * concurrent writes never produce a partially-written file.
 */

import { z } from 'zod';
import type { BackgroundJobHandle } from './async-job-manager.js';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const JSON_FILE_SUFFIX = '.json';

const BackgroundJobResultSchema = z.object({
    status: z.enum(['completed', 'failed']),
    output: z.string(),
});

const BackgroundJobHandleSchema = z.object({
    jobId: z.string().min(1),
    sessionId: z.string().min(1),
    status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
    result: BackgroundJobResultSchema.optional(),
    error: z.string().optional(),
    startedAt: z.string().min(1),
    completedAt: z.string().optional(),
});

/**
 * Atomically persist `handle` to `<jobsDir>/<jobId>.json`. The payload is
 * validated through {@link BackgroundJobHandleSchema} at the boundary, then
 * written to a unique temp file and renamed into place. Concurrent calls (even
 * for the same jobId) never corrupt each other.
 */
export async function persistJob(jobsDir: string, handle: BackgroundJobHandle): Promise<void> {
    const validated = BackgroundJobHandleSchema.parse(handle);
    const filePath = join(jobsDir, `${handle.jobId}${JSON_FILE_SUFFIX}`);
    await atomicWriteJson(filePath, validated);
}

/**
 * Read every `<jobsDir>/*.json` file and return the parsed handles. Files that
 * are unreadable, unparseable, or fail schema validation are skipped — this
 * function never throws on per-file corruption. Returns an empty array when
 * the directory does not exist.
 */
export async function loadPersistedJobs(jobsDir: string): Promise<readonly BackgroundJobHandle[]> {
    let entries: readonly string[];
    try {
        entries = await readdir(jobsDir);
    } catch (error: unknown) {
        if (isErrorCode(error, 'ENOENT')) {
            return [];
        }
        throw error;
    }

    const handles: BackgroundJobHandle[] = [];
    for (const entry of entries) {
        if (!entry.endsWith(JSON_FILE_SUFFIX)) continue;
        const handle = await tryReadJobFile(join(jobsDir, entry));
        if (handle !== undefined) {
            handles.push(handle);
        }
    }
    return handles;
}

async function tryReadJobFile(filePath: string): Promise<BackgroundJobHandle | undefined> {
    let contents: string;
    try {
        contents = await readFile(filePath, 'utf8');
    } catch {
        return undefined;
    }
    let parsed: unknown;
    try {
        parsed = JSON.parse(contents);
    } catch {
        return undefined;
    }
    const result = BackgroundJobHandleSchema.safeParse(parsed);
    if (!result.success) {
        return undefined;
    }
    const v = result.data;
    // Conditional spreads satisfy `exactOptionalPropertyTypes`: absent vs undefined.
    const handle: BackgroundJobHandle = {
        jobId: v.jobId,
        sessionId: v.sessionId,
        status: v.status,
        startedAt: v.startedAt,
        ...(v.result !== undefined ? { result: v.result } : {}),
        ...(v.error !== undefined ? { error: v.error } : {}),
        ...(v.completedAt !== undefined ? { completedAt: v.completedAt } : {}),
    };
    return handle;
}

async function atomicWriteJson(filePath: string, value: unknown): Promise<void> {
    const serialized = `${JSON.stringify(value, null, 2)}\n`;
    const tempPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
    await mkdir(dirname(filePath), { recursive: true });
    await writeFile(tempPath, serialized, { encoding: 'utf8', flag: 'wx' });
    await rename(tempPath, filePath);
    await rm(tempPath, { force: true });
}

function isErrorCode(error: unknown, code: string): boolean {
    return (
        typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        (error as { readonly code?: unknown }).code === code
    );
}
