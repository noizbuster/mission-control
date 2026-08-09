/**
 * Persists {@link DurableBackgroundJobHandle} instances to disk so AsyncJobManager
 * background jobs survive process restarts. Each job is stored as a single JSON
 * file at `<jobsDir>/<jobId>.json`. Writes are atomic (temp-file-then-rename)
 * following the `.mc/` persistence convention from `boulder-store.ts`, so
 * concurrent writes never produce a partially-written file.
 */

import { ProtocolErrorSchema } from '@mission-control/protocol';
import { isErrorCode } from '../util/node-error';
import { z } from 'zod';
import type { BackgroundJobHandle, DurableBackgroundJobHandle } from './async-job-manager';
import { atomicWriteJsonFile } from '../persistence/atomic-write';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const JSON_FILE_SUFFIX = '.json';

const BackgroundJobResultSchema = z.object({
    status: z.enum(['completed', 'failed']),
    output: z.string(),
    failure: ProtocolErrorSchema.optional(),
});

const BackgroundJobHandleSchema = z.object({
    jobId: z.string().min(1),
    sessionId: z.string().min(1),
    parentSessionId: z.string().min(1).optional(),
    agentId: z.string().min(1).optional(),
    blocking: z.boolean().optional(),
    status: z.enum(['queued', 'running', 'completed', 'failed', 'cancelled']),
    result: BackgroundJobResultSchema.optional(),
    startedAt: z.string().min(1),
    completedAt: z.string().optional(),
    cancellationReason: z.string().optional(),
});

/**
 * Atomically persist `handle` to `<jobsDir>/<jobId>.json`. The payload is
 * validated through {@link BackgroundJobHandleSchema} at the boundary, then
 * written to a unique temp file and renamed into place. Concurrent calls (even
 * for the same jobId) never corrupt each other.
 */
/** Process-local per-jobPath chains so concurrent persistJob of the same id cannot clobber. */
const jobWriteChains = new Map<string, Promise<unknown>>();

function enqueueJobWrite<T>(path: string, task: () => Promise<T>): Promise<T> {
    const previous = jobWriteChains.get(path) ?? Promise.resolve();
    const run = previous.then(task, task);
    jobWriteChains.set(
        path,
        run.then(
            () => undefined,
            () => undefined,
        ),
    );
    return run;
}

export async function persistJob(jobsDir: string, handle: DurableBackgroundJobHandle): Promise<void> {
    const validated = BackgroundJobHandleSchema.parse(handle);
    const filePath = join(jobsDir, `${handle.jobId}${JSON_FILE_SUFFIX}`);
    await enqueueJobWrite(filePath, async () => {
        await atomicWriteJsonFile(filePath, validated);
    });
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
    const parsedResult = v.result;
    const jobResult =
        parsedResult === undefined
            ? undefined
            : {
                  status: parsedResult.status,
                  output: parsedResult.output,
                  ...(parsedResult.failure !== undefined ? { failure: parsedResult.failure } : {}),
              };
    // Conditional spreads satisfy `exactOptionalPropertyTypes`: absent vs undefined.
    const handle: BackgroundJobHandle = {
        jobId: v.jobId,
        sessionId: v.sessionId,
        ...(v.parentSessionId !== undefined ? { parentSessionId: v.parentSessionId } : {}),
        ...(v.agentId !== undefined ? { agentId: v.agentId } : {}),
        ...(v.blocking !== undefined ? { blocking: v.blocking } : {}),
        status: v.status,
        startedAt: v.startedAt,
        ...(jobResult !== undefined ? { result: jobResult } : {}),
        ...(v.completedAt !== undefined ? { completedAt: v.completedAt } : {}),
        ...(v.cancellationReason !== undefined ? { cancellationReason: v.cancellationReason } : {}),
    };
    return handle;
}


