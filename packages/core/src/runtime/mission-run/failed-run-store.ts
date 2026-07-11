import type { Run } from '@mission-control/protocol';
import { listRunsFromDb } from './mission-run-db.js';

export async function findMostRecentFailedRunRecord(root: string): Promise<Run | undefined> {
    return latestFailedRun(await listRunsFromDb(root));
}

function latestFailedRun(runs: readonly Run[]): Run | undefined {
    let latest: Run | undefined;
    for (const run of runs) {
        if (run.status !== 'failed') continue;
        if (latest === undefined || compareEndedAt(run, latest) > 0) latest = run;
    }
    return latest;
}

function compareEndedAt(left: Run, right: Run): number {
    const leftTimestamp = left.endedAt ?? '';
    const rightTimestamp = right.endedAt ?? '';
    if (leftTimestamp < rightTimestamp) return -1;
    if (leftTimestamp > rightTimestamp) return 1;
    return 0;
}
