/**
 * Recovers persisted background jobs after a runtime restart. Jobs that were
 * 'queued' or 'running' at crash time are marked 'cancelled' (no auto-
 * reexecution). Terminal jobs ('completed', 'failed', 'cancelled') are
 * preserved unchanged.
 */

import { type BackgroundJobHandle, durableSnapshotJobHandle } from './async-job-manager';
import { loadPersistedJobs, persistJob } from './job-persistence';

export interface RecoveryReport {
    readonly recovered: number;
    readonly cancelled: number;
    readonly preserved: number;
}

const ACTIVE_STATUSES: ReadonlySet<BackgroundJobHandle['status']> = new Set(['queued', 'running']);

/**
 * Scan `jobsDir` for persisted job handles and reconcile their state after a
 * restart. Each active job ('queued' or 'running') is transitioned to
 * 'cancelled' with a completion timestamp, then re-persisted. Terminal jobs
 * ('completed', 'failed', 'cancelled') are left untouched.
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
            await persistJob(
                jobsDir,
                durableSnapshotJobHandle({
                    ...job,
                    status: 'cancelled',
                    completedAt: new Date().toISOString(),
                }),
            );
            cancelled++;
        } else {
            preserved++;
        }
    }

    return { recovered: jobs.length, cancelled, preserved };
}
