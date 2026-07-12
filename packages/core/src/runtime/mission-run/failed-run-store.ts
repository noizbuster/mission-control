import type { Run } from '@mission-control/protocol';

export function findMostRecentFailedRunRecord(runs: readonly Run[]): Run | undefined {
    return latestFailedRun(runs);
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
