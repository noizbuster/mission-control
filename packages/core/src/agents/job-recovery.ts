/**
 * Recovers persisted background jobs after a runtime restart. Jobs that were
 * 'queued' or 'running' at crash time are marked 'cancelled' (no auto-
 * reexecution) with a salvage snippet in their `error` field recording that
 * recovery cancelled them. Terminal jobs ('completed', 'failed', 'cancelled')
 * are preserved unchanged.
 */

import type { BackgroundJobHandle } from './async-job-manager.js';
import { loadPersistedJobs, persistJob } from './job-persistence.js';
import { formatSalvageSnippet } from './runaway-guard.js';

export interface RecoveryReport {
    readonly recovered: number;
    readonly cancelled: number;
    readonly preserved: number;
}

const ACTIVE_STATUSES: ReadonlySet<BackgroundJobHandle['status']> = new Set(['queued', 'running']);

/**
 * Scan `jobsDir` for persisted job handles and reconcile their state after a
 * restart. Each active job ('queued' or 'running') is transitioned to
 * 'cancelled', stamped with a salvage snippet and a completion timestamp, then
 * re-persisted. Terminal jobs ('completed', 'failed', 'cancelled') are left
 * untouched.
 *
 * `recovered` is the total number of jobs loaded from disk, `cancelled` is how
 * many were transitioned, and `preserved` is how many were already terminal.
 */
export async function recoverJobs(jobsDir: string): Promise<RecoveryReport> {
    const jobs = await loadPersistedJobs(jobsDir);

    let cancelled = 0;
    let preserved = 0;

    for (const job of jobs) {
        if (ACTIVE_STATUSES.has(job.status)) {
            job.status = 'cancelled';
            job.error = formatSalvageSnippet(0, undefined, undefined);
            job.completedAt = new Date().toISOString();
            await persistJob(jobsDir, job);
            cancelled++;
        } else {
            preserved++;
        }
    }

    return { recovered: jobs.length, cancelled, preserved };
}
