import type { AbgSignal } from '@mission-control/protocol';

export const DEFAULT_RACE_CLEANUP_TIMEOUT_MS = 5_000;
export const MAX_RACE_CLEANUP_TIMEOUT_MS = 30_000;

export type RaceCleanupTarget = {
    readonly childId: string;
    readonly iterator: AsyncIterator<AbgSignal>;
    readonly pump: Promise<unknown>;
};

type RaceDrainFailure = {
    readonly code: 'race_child_drain_failed';
    readonly childId: string;
    readonly message: string;
};

type RacePumpFailure = {
    readonly code: 'race_child_pump_failed';
    readonly childId: string;
    readonly message: string;
};

export type RaceCleanupFailure =
    | RaceDrainFailure
    | RacePumpFailure
    | {
          readonly code: 'race_cleanup_timeout';
          readonly childIds: readonly string[];
          readonly message: string;
      };

type RaceReturnResult = { readonly ok: true } | { readonly ok: false; readonly failure: RaceDrainFailure };

export type RaceCleanupResult =
    | { readonly ok: true }
    | { readonly ok: false; readonly failures: readonly RaceCleanupFailure[] };

type RaceCleanupInput = {
    readonly targets: readonly RaceCleanupTarget[];
    readonly timeoutMs: number;
};

type TargetFailures = {
    returnFailure?: RaceDrainFailure;
    pumpFailure?: RacePumpFailure;
};

export async function cleanupRaceBranches(input: RaceCleanupInput): Promise<RaceCleanupResult> {
    const pendingTargets = new Set(input.targets);
    const failuresByTarget = new Map<RaceCleanupTarget, TargetFailures>();
    const cleanupTasks = input.targets.map(async (target) => {
        const targetFailures: TargetFailures = {};
        failuresByTarget.set(target, targetFailures);
        const returnTask = returnRaceBranch(target).then((result) => {
            if (!result.ok) targetFailures.returnFailure = result.failure;
        });
        const pumpTask = settleRacePump(target).then((pumpFailure) => {
            if (pumpFailure !== undefined) targetFailures.pumpFailure = pumpFailure;
        });
        await Promise.all([returnTask, pumpTask]);
        pendingTargets.delete(target);
    });
    const completed = Promise.all(cleanupTasks).then((): RaceCleanupResult => {
        const failures = collectFailures(input.targets, failuresByTarget);
        return failures.length === 0 ? { ok: true } : { ok: false, failures };
    });
    let timerId: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<RaceCleanupResult>((resolve) => {
        timerId = setTimeout(() => {
            const childIds = input.targets
                .filter((target) => pendingTargets.has(target))
                .map((target) => target.childId);
            const failures = collectFailures(input.targets, failuresByTarget);
            resolve({
                ok: false,
                failures: [
                    ...failures,
                    {
                        code: 'race_cleanup_timeout',
                        childIds,
                        message: `race cleanup exceeded ${input.timeoutMs}ms`,
                    },
                ],
            });
        }, input.timeoutMs);
    });
    try {
        return await Promise.race([completed, timedOut]);
    } finally {
        if (timerId !== undefined) clearTimeout(timerId);
    }
}

async function settleRacePump(target: RaceCleanupTarget): Promise<RacePumpFailure | undefined> {
    try {
        await target.pump;
        return undefined;
    } catch (cause) {
        return {
            code: 'race_child_pump_failed',
            childId: target.childId,
            message: cause instanceof Error ? cause.message : String(cause),
        };
    }
}

async function returnRaceBranch(target: RaceCleanupTarget): Promise<RaceReturnResult> {
    try {
        await target.iterator.return?.(undefined);
        return { ok: true };
    } catch (cause) {
        return {
            ok: false,
            failure: {
                code: 'race_child_drain_failed',
                childId: target.childId,
                message: cause instanceof Error ? cause.message : String(cause),
            },
        };
    }
}

function collectFailures(
    targets: readonly RaceCleanupTarget[],
    failuresByTarget: ReadonlyMap<RaceCleanupTarget, TargetFailures>,
): readonly RaceCleanupFailure[] {
    const failures: RaceCleanupFailure[] = [];
    for (const target of targets) {
        const targetFailures = failuresByTarget.get(target);
        if (targetFailures?.returnFailure !== undefined) failures.push(targetFailures.returnFailure);
        if (targetFailures?.pumpFailure !== undefined) failures.push(targetFailures.pumpFailure);
    }
    return failures;
}
