/**
 * ABG Speculative-Parallel node (ABG §9, Phase 6 deferred item).
 *
 * Runs N branches CONCURRENTLY (speculative execution) and applies a join-rank + early-stop
 * policy:
 *   - **Early-stop:** as soon as a branch produces a result meeting the `stopThreshold`
 *     (a score ≥ threshold read from each branch's terminal result), it is declared the
 *     winner and the remaining branches are abandoned (their async iterators are `.return()`ed
 *     so their cleanup runs deterministically).
 *   - **Join-rank:** if no branch trips the early-stop before all complete, the winner is the
 *     branch with the highest score (`rankBy: 'score'`, the default) — or the first to
 *     complete (`rankBy: 'first'`).
 *
 * The policy is PURE (extracted + unit-tested below); the runner is the concurrency primitive.
 * Scores come from each branch's terminal `success` result payload (`{ score: number }`),
 * keeping the node observable + deterministic (no wall-clock races decide the outcome — the
 * scores do; ties break by declaration order).
 */
import type { AbgNodeSpec, AbgSignal } from '@mission-control/protocol';
import type { AbgNodeRunContext, AbgNodeRunner } from '../node-registry.js';
import { failure, isFailureSignal, readStringConfig, started, success } from './composite-node-utils.js';

export type SpeculativeRankBy = 'first' | 'score';

export type BranchOutcome = {
    readonly childId: string;
    readonly score: number;
    /** True when the branch reached `success` (false on failure/cancel). */
    readonly succeeded: boolean;
    readonly result: unknown;
};

export type SpeculativeDecision = {
    readonly winnerId: string | undefined;
    readonly earlyStop: boolean;
    readonly outcomes: readonly BranchOutcome[];
};

/** Read a numeric `score` from a branch's terminal result (default 0). */
export function readBranchScore(result: unknown): number {
    if (result === null || typeof result !== 'object') {
        return 0;
    }
    const score = (result as { score?: unknown }).score;
    return typeof score === 'number' && Number.isFinite(score) ? score : 0;
}

/**
 * Pure decision: given branch outcomes, a rank strategy, and an optional early-stop threshold,
 * pick the winner. Early-stop fires when a succeeded branch's score ≥ threshold (first such
 * branch in declaration order wins ties). Otherwise the highest-scoring succeeded branch wins
 * (or `first`-completed for `rankBy: 'first'`). `undefined` winner = no branch succeeded.
 */
export function decideSpeculativeWinner(
    outcomes: readonly BranchOutcome[],
    rankBy: SpeculativeRankBy,
    stopThreshold?: number,
): SpeculativeDecision {
    const succeeded = outcomes.filter((outcome) => outcome.succeeded);
    if (stopThreshold !== undefined) {
        const earlyWinner = succeeded.find((outcome) => outcome.score >= stopThreshold);
        if (earlyWinner !== undefined) {
            return { winnerId: earlyWinner.childId, earlyStop: true, outcomes };
        }
    }
    if (rankBy === 'first') {
        const first = succeeded[0];
        return { winnerId: first?.childId, earlyStop: false, outcomes };
    }
    let best: BranchOutcome | undefined;
    for (const outcome of succeeded) {
        if (best === undefined || outcome.score > best.score) {
            best = outcome;
        }
    }
    return { winnerId: best?.childId, earlyStop: false, outcomes };
}

export const runSpeculativeNode: AbgNodeRunner = async function* (
    node: AbgNodeSpec,
    context: AbgNodeRunContext,
): AsyncIterable<AbgSignal> {
    yield started(node, context);

    const childIds = node.children ?? [];
    if (childIds.length === 0) {
        yield failure(node, context, { code: 'speculative_requires_children' });
        return;
    }
    const registry = context.registry;
    if (registry === undefined) {
        yield failure(node, context, { code: 'speculative_requires_registry' });
        return;
    }

    const rankBy: SpeculativeRankBy = readStringConfig(node, 'rankBy') === 'first' ? 'first' : 'score';
    const stopThreshold = readNumberConfig(node, 'stopThreshold');

    // Each branch is drained to its terminal signal concurrently. We collect signals per
    // branch and resolve the branch as soon as it terminates; then check for early-stop.
    type Branch = {
        readonly childId: string;
        readonly iterator: AsyncIterator<AbgSignal>;
        outcome: BranchOutcome | undefined;
    };
    const branches: Branch[] = childIds.map((childId) => {
        const child = context.nodes?.[childId];
        if (child === undefined) {
            throw new Error(`Unknown ABG child node: ${childId}`);
        }
        const stream = registry.resolve(child.implementation ?? child.kind)(child, context);
        return { childId, iterator: stream[Symbol.asyncIterator](), outcome: undefined };
    });

    const outcomes: BranchOutcome[] = [];
    let winnerId: string | undefined;
    let earlyStop = false;

    try {
        while (branches.some((branch) => branch.outcome === undefined)) {
            // Step every still-running branch by one signal in parallel.
            const steps = await Promise.all(
                branches
                    .filter((branch) => branch.outcome === undefined)
                    .map(async (branch) => {
                        const next = await branch.iterator.next();
                        return { branch, next };
                    }),
            );
            for (const { branch, next } of steps) {
                if (next.done === true) {
                    branch.outcome = outcomeFromTerminal(branch.childId, false, next.value);
                    outcomes.push(branch.outcome);
                    continue;
                }
                yield next.value as AbgSignal;
                const signal = next.value as AbgSignal;
                if (signal.type === 'success' || isFailureSignal(signal)) {
                    branch.outcome = outcomeFromTerminal(
                        branch.childId,
                        signal.type === 'success',
                        signal.type === 'success' ? signal.result : undefined,
                    );
                    outcomes.push(branch.outcome);
                }
            }
            // Early-stop check after each concurrent step.
            if (stopThreshold !== undefined) {
                const decision = decideSpeculativeWinner(outcomes, rankBy, stopThreshold);
                if (decision.earlyStop && decision.winnerId !== undefined) {
                    winnerId = decision.winnerId;
                    earlyStop = true;
                    break;
                }
            }
        }
    } finally {
        // Abandon (deterministically cancel) any branch not yet terminated so its generator
        // cleanup runs — whether we early-stopped or drained to completion.
        for (const branch of branches) {
            if (branch.outcome === undefined) {
                await branch.iterator.return?.(undefined);
            }
        }
    }

    if (winnerId === undefined) {
        const decision = decideSpeculativeWinner(outcomes, rankBy);
        winnerId = decision.winnerId;
    }
    if (winnerId === undefined) {
        yield failure(node, context, { code: 'speculative_no_branch_succeeded', outcomes });
        return;
    }
    const winner = outcomes.find((outcome) => outcome.childId === winnerId);
    yield success(node, context, { winnerId, earlyStop, outcomes, result: winner?.result });
};

function readNumberConfig(node: AbgNodeSpec, key: string): number | undefined {
    const value = node.config?.[key];
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function outcomeFromTerminal(childId: string, succeeded: boolean, result: unknown): BranchOutcome {
    return { childId, score: readBranchScore(result), succeeded, result };
}

export type { AbgNodeRunner };
