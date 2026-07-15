import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry';
import { cancelled, failure, isFailureSignal, started, success } from './composite-node-utils';
import {
    cleanupRaceBranches,
    DEFAULT_RACE_CLEANUP_TIMEOUT_MS,
    MAX_RACE_CLEANUP_TIMEOUT_MS,
    type RaceCleanupFailure,
} from './race-cleanup';

export const MAX_RACE_CHILDREN = 4;

type RunChild = (childId: string, context: AbgNodeRunContext) => AsyncIterable<AbgSignal>;

type RaceOutcome = {
    readonly succeeded: boolean;
    readonly valid: boolean;
};

type RaceBranch = {
    readonly childId: string;
    readonly iterator: AsyncIterator<AbgSignal>;
    readonly signals: AbgSignal[];
    outcome: RaceOutcome | undefined;
};

type RacePumpCompletion = {
    readonly branch: RaceBranch;
    readonly pumpRejected: boolean;
};

export function createRaceNodeRunner(runChild: RunChild): AbgNodeRunner {
    return async function* runRaceNode(node: AbgNodeSpec, context: AbgNodeRunContext): AsyncIterable<AbgSignal> {
        yield started(node, context);
        const childIds = node.children ?? [];
        if (childIds.length === 0) {
            yield failure(node, context, { code: 'race_requires_children' });
            return;
        }
        if (childIds.length > MAX_RACE_CHILDREN) {
            yield failure(node, context, {
                code: 'race_child_limit_exceeded',
                childCount: childIds.length,
                maxChildren: MAX_RACE_CHILDREN,
            });
            return;
        }
        const { cleanupTimeoutMs: configuredCleanupTimeoutMs } = node.config ?? {};
        if (
            configuredCleanupTimeoutMs !== undefined &&
            (typeof configuredCleanupTimeoutMs !== 'number' ||
                !Number.isInteger(configuredCleanupTimeoutMs) ||
                configuredCleanupTimeoutMs <= 0 ||
                configuredCleanupTimeoutMs > MAX_RACE_CLEANUP_TIMEOUT_MS)
        ) {
            yield failure(node, context, {
                code: 'race_cleanup_timeout_invalid',
                cleanupTimeoutMs: configuredCleanupTimeoutMs,
                maxCleanupTimeoutMs: MAX_RACE_CLEANUP_TIMEOUT_MS,
            });
            return;
        }
        const cleanupTimeoutMs = configuredCleanupTimeoutMs ?? DEFAULT_RACE_CLEANUP_TIMEOUT_MS;

        const branches: RaceBranch[] = childIds.map((childId) => ({
            childId,
            iterator: runChild(childId, context)[Symbol.asyncIterator](),
            signals: [],
            outcome: undefined,
        }));
        const pending = new Map<Promise<RacePumpCompletion>, RaceBranch>();
        const cleanupTargets = [];
        for (const branch of branches) {
            const pump = pumpRaceBranch(branch);
            const completion = pump.then(
                (completedBranch): RacePumpCompletion => ({ branch: completedBranch, pumpRejected: false }),
                (): RacePumpCompletion => ({ branch, pumpRejected: true }),
            );
            cleanupTargets.push({ childId: branch.childId, iterator: branch.iterator, pump });
            pending.set(completion, branch);
        }

        let winner: RaceBranch | undefined;
        while (pending.size > 0 && winner === undefined) {
            // Arbitration is process-local only. Durable committed-order arbitration remains deferred.
            const completed = await Promise.race(pending.keys());
            const completedPromise = [...pending.entries()].find((entry) => entry[1] === completed.branch)?.[0];
            if (completedPromise !== undefined) {
                pending.delete(completedPromise);
            }
            if (completed.pumpRejected) {
                break;
            }
            if (completed.branch.outcome?.succeeded === true && completed.branch.outcome.valid === true) {
                winner = completed.branch;
            }
        }

        const activeLosers =
            winner === undefined ? [] : branches.filter((branch) => branch !== winner && branch.outcome === undefined);
        const cleanup = await cleanupRaceBranches({ targets: cleanupTargets, timeoutMs: cleanupTimeoutMs });

        const cancelledLosers = activeLosers
            .map((branch) => branch.childId)
            .sort((left, right) => childIds.indexOf(left) - childIds.indexOf(right));

        for (const branch of branches) {
            for (const signal of branch.signals) {
                if (winner !== undefined && branch !== winner && isFailureSignal(signal)) {
                    continue;
                }
                yield signal;
            }
        }
        if (!cleanup.ok) {
            for (const cleanupFailure of cleanup.failures) {
                for (const signal of cleanupFailureSignals(cleanupFailure, context)) {
                    yield signal;
                }
            }
            yield failure(node, context, { code: 'race_cleanup_failed', failures: cleanup.failures });
            return;
        }
        for (const loserId of cancelledLosers) {
            yield cancelled(loserId, context, 'race loser cancelled');
        }
        if (winner === undefined) {
            yield failure(node, context, { code: 'race_no_valid_success' });
            return;
        }
        yield success(node, context, { winnerChild: winner.childId });
    };
}

async function pumpRaceBranch(branch: RaceBranch): Promise<RaceBranch> {
    while (true) {
        const next = await branch.iterator.next();
        if (next.done === true) {
            branch.outcome = { succeeded: false, valid: false };
            return branch;
        }
        branch.signals.push(next.value);
        if (next.value.type === 'success') {
            branch.outcome = { succeeded: true, valid: isValidRaceSuccess(next.value.result) };
            return branch;
        }
        if (isFailureSignal(next.value)) {
            branch.outcome = { succeeded: false, valid: false };
            return branch;
        }
    }
}

function cleanupFailureSignals(failureValue: RaceCleanupFailure, context: AbgNodeRunContext): readonly AbgSignal[] {
    switch (failureValue.code) {
        case 'race_child_drain_failed':
            return [raceFailureSignal(context, failureValue.childId, failureValue.code, failureValue.message)];
        case 'race_child_pump_failed':
            return [raceFailureSignal(context, failureValue.childId, failureValue.code, failureValue.message)];
        case 'race_cleanup_timeout':
            return failureValue.childIds.map((childId) =>
                raceFailureSignal(context, childId, 'race_child_cleanup_timeout', failureValue.message),
            );
    }
}

function raceFailureSignal(context: AbgNodeRunContext, childId: string, code: string, cause: unknown): AbgSignal {
    return {
        type: 'failure',
        graphId: context.graphId,
        nodeId: childId,
        error: {
            code,
            message: cause instanceof Error ? cause.message : String(cause),
        },
    };
}

function isValidRaceSuccess(result: unknown): boolean {
    if (typeof result !== 'object' || result === null || !('valid' in result)) {
        return true;
    }
    return result.valid === true;
}
