import { isNodeError } from '../util/node-error';
import {
    type BoulderState,
    BoulderStoreError,
    type BoulderWork,
    boulderFilePath,
    enqueueBoulderWrite,
    readBoulder,
    writeBoulderUnchained,
} from './boulder-store';
import { type FileHandle, mkdir, open, readFile, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export async function mutateBoulderWork(
    root: string,
    workId: string,
    mutation: (work: BoulderWork) => BoulderWork,
): Promise<BoulderState> {
    // Share the process-local root chain with updateBoulderWork so mixed callers
    // cannot last-write-win; keep the cross-process .lock around the RMW body.
    return enqueueBoulderWrite(root, async () =>
        withBoulderMutationLock(root, async () => {
            const key = boulderFilePath(root);
            const state = await readBoulder(root);
            if (state === null) {
                throw new BoulderStoreError(
                    `Cannot mutate work ${workId}: boulder.json is missing at ${key}`,
                    'boulder_missing',
                    key,
                );
            }
            const work = state.works[workId];
            if (work === undefined) {
                throw new BoulderStoreError(
                    `Cannot mutate work ${workId}: not present in boulder works`,
                    'boulder_work_missing',
                    key,
                );
            }
            const updated: BoulderState = {
                ...state,
                works: { ...state.works, [workId]: mutation(work) },
            };
            await writeBoulderUnchained(root, updated);
            return updated;
        }),
    );
}
// Cross-process lock standard ported from team-store's task-list lock
// (team-store.ts: LOCK_RETRY_MS / LOCK_BACKOFF_MAX_MS / LOCK_STALE_AFTER_MS /
// LOCK_DEFAULT_TIMEOUT_MS): bounded retry with backoff, stale reaping by age
// or dead holder PID, and a hard timeout that still fails closed.
const LOCK_RETRY_MS = 25;
const LOCK_BACKOFF_MAX_MS = 200;
const LOCK_STALE_AFTER_MS = 10_000;
const LOCK_TIMEOUT_MS = 5_000;

type BoulderMutationLockTimings = {
    readonly timeoutMs: number;
    readonly retryDelayMs: number;
    readonly backoffMaxMs: number;
    readonly staleAfterMs: number;
    readonly now: () => number;
};

const defaultLockTimings: BoulderMutationLockTimings = {
    timeoutMs: LOCK_TIMEOUT_MS,
    retryDelayMs: LOCK_RETRY_MS,
    backoffMaxMs: LOCK_BACKOFF_MAX_MS,
    staleAfterMs: LOCK_STALE_AFTER_MS,
    now: () => Date.now(),
};

let lockTimings: BoulderMutationLockTimings = defaultLockTimings;

/** Test-only: override lock retry/staleness timings so contention tests stay fast and deterministic. */
export function _testSetBoulderMutationLockTimings(overrides: Partial<BoulderMutationLockTimings>): void {
    lockTimings = { ...defaultLockTimings, ...overrides };
}

/** Test-only: restore production lock timings. */
export function _testResetBoulderMutationLockTimings(): void {
    lockTimings = defaultLockTimings;
}

async function withBoulderMutationLock<Result>(root: string, operation: () => Promise<Result>): Promise<Result> {
    const lockPath = `${boulderFilePath(root)}.lock`;
    await mkdir(dirname(lockPath), { recursive: true });
    // The lock is held by keeping an O_EXCL file handle open; releasing is unlink.
    // A lock whose stamped holder PID is dead, or whose acquisition stamp is older
    // than the staleness threshold, is reaped so a crashed writer cannot wedge
    // boulder mutations until manual cleanup. A genuinely held lock still fails
    // closed with `boulder_lock_busy`.
    const deadline = lockTimings.now() + lockTimings.timeoutMs;
    let delay = lockTimings.retryDelayMs;
    let handle: FileHandle | undefined;
    try {
        while (true) {
            try {
                handle = await open(lockPath, 'wx', 0o600);
                break;
            } catch (error: unknown) {
                if (!isNodeError(error, 'EEXIST')) throw error;
                await reapStaleBoulderLock(lockPath);
                if (lockTimings.now() >= deadline) {
                    throw new BoulderStoreError(
                        `Cannot mutate boulder state while another process holds ${lockPath}`,
                        'boulder_lock_busy',
                        lockPath,
                        error,
                    );
                }
                await new Promise<void>((resolve) => {
                    setTimeout(resolve, delay);
                });
                delay = Math.min(lockTimings.backoffMaxMs, delay * 2);
            }
        }
        // Stamp the lock with holder pid + acquisition time for stale reaping.
        await handle.writeFile(`${process.pid}\n${lockTimings.now()}\n`, 'utf8');
        return await operation();
    } finally {
        // Only release a lock this call acquired; a timed-out waiter must not
        // unlink the live holder's lock file.
        if (handle !== undefined) {
            try {
                await handle.close();
            } catch {
                // Best effort; the unlink below is the real release.
            }
            await rm(lockPath, { force: true });
        }
    }
}

async function reapStaleBoulderLock(lockPath: string): Promise<void> {
    let contents: string;
    try {
        contents = await readFile(lockPath, 'utf8');
    } catch {
        return;
    }
    const lines = contents.split('\n');
    const pid = Number(lines[0]);
    const acquiredAt = Number(lines[1] ?? '0');
    const holderDead = Number.isInteger(pid) && pid > 0 && pid !== process.pid && !isProcessAlive(pid);
    const tooOld = Number.isFinite(acquiredAt) && lockTimings.now() - acquiredAt > lockTimings.staleAfterMs;
    if (holderDead || tooOld) {
        await rm(lockPath, { force: true });
    }
}

function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error: unknown) {
        // ESRCH: no such process. EPERM: exists but owned by another user. Treat
        // anything unrecognized as alive so reaping stays conservative.
        return !isNodeError(error, 'ESRCH');
    }
}
