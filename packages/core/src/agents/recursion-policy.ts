/**
 * Recursion-depth gate for abstract chains and production nested `task()`.
 *
 * Production nesting uses {@linkcode PRODUCTION_MAX_TASK_DEPTH} exclusively via
 * `canSpawnAtDepth(PRODUCTION_MAX_TASK_DEPTH, childDepth)`. Do not repurpose
 * {@linkcode DEFAULT_MAX_RECURSION_DEPTH} as the live product cap — it remains
 * `2` for compatibility tests and imported-agent bookkeeping only.
 *
 * Semantics:
 *   - `maxRecursionDepth >= 0`: spawning is allowed while
 *     `taskDepth < maxRecursionDepth` (strict less-than boundary).
 *   - `maxRecursionDepth < 0` (unlimited): the user-configured cap is
 *     disabled, but {@linkcode HARD_RECURSION_CAP} still applies — spawning is
 *     allowed while `taskDepth < HARD_RECURSION_CAP`.
 *   - `maxRecursionDepth === 0`: no spawning is ever permitted (the task tool
 *     is revoked immediately, even at the root).
 */

/**
 * Default depth for standalone compatibility calculations. A value of 2 means
 * depth 0 and depth 1 pass while depth 2 is the blocked boundary.
 * Not the production nested-task cap — see {@linkcode PRODUCTION_MAX_TASK_DEPTH}.
 */
export const DEFAULT_MAX_RECURSION_DEPTH = 2;

/**
 * Production nested-`task` depth cap. With max=3, depths 0/1/2 may spawn and
 * depth 3 is the blocked leaf (MAIN→d1→d2→d3). The only production gate.
 */
export const PRODUCTION_MAX_TASK_DEPTH = 3;

/**
 * Absolute ceiling on recursion depth that applies even when
 * `maxRecursionDepth < 0` (unlimited). Prevents pathological runaway
 * recursion when a caller disables the user-configured cap.
 */
export const HARD_RECURSION_CAP = 10;

/**
 * Whether an abstract chain at `taskDepth` remains below its compatibility cap.
 *
 * - `maxRecursionDepth < 0` disables the user-configured cap; only
 *   {@linkcode HARD_RECURSION_CAP} applies.
 * - Otherwise spawning is allowed while `taskDepth < maxRecursionDepth`.
 *
 * Mirrors oh-my-pi `canSpawnAtDepth` (`packages/coding-agent/src/task/types.ts:214`),
 * extended with the hard-cap branch for the unlimited case.
 */
export function canSpawnAtDepth(maxRecursionDepth: number, taskDepth: number): boolean {
    if (maxRecursionDepth < 0) return taskDepth < HARD_RECURSION_CAP;
    return taskDepth < maxRecursionDepth;
}

/**
 * Stateless depth bookkeeper for a spawn chain.
 *
 * Wraps {@linkcode canSpawnAtDepth} with a fixed `maxDepth` so callers thread
 * only the current depth through standalone calculations. `childDepth`
 * computes the next abstract depth.
 */
export class RecursionTracker {
    private readonly maxDepth: number;

    constructor(maxDepth: number = DEFAULT_MAX_RECURSION_DEPTH) {
        this.maxDepth = maxDepth;
    }

    /** Whether `currentDepth` remains below the configured compatibility cap. */
    canSpawn(currentDepth: number): boolean {
        return canSpawnAtDepth(this.maxDepth, currentDepth);
    }

    /** The next depth after `parentDepth`. */
    childDepth(parentDepth: number): number {
        return parentDepth + 1;
    }
}
