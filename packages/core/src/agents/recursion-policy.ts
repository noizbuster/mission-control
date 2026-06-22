/**
 * Recursion-depth policy for child-agent delegation.
 *
 * Determines whether an agent at a given `taskDepth` may still spawn children
 * (i.e. whether it still holds the `task` tool). Mirrors oh-my-pi's
 * `canSpawnAtDepth` gate (`task/types.ts:214`) with one extension: a hard cap
 * that bounds even unlimited configurations so recursion cannot run away.
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
 * Default maximum recursion depth. A value of 2 means a root agent (depth 0)
 * may spawn a child (depth 1), and that child may spawn one more grandchild
 * (depth 2 is the boundary, blocked).
 */
export const DEFAULT_MAX_RECURSION_DEPTH = 2;

/**
 * Absolute ceiling on recursion depth that applies even when
 * `maxRecursionDepth < 0` (unlimited). Prevents pathological runaway
 * recursion when a caller disables the user-configured cap.
 */
export const HARD_RECURSION_CAP = 10;

/**
 * Whether an agent at `taskDepth` may still spawn children.
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
 * only the current depth through spawn boundaries. `childDepth` computes the
 * depth a newly spawned child would live at, so a parent can decide whether to
 * spawn and propagate the correct depth in one step.
 */
export class RecursionTracker {
    private readonly maxDepth: number;

    constructor(maxDepth: number = DEFAULT_MAX_RECURSION_DEPTH) {
        this.maxDepth = maxDepth;
    }

    /** Whether an agent at `currentDepth` may spawn a child. */
    canSpawn(currentDepth: number): boolean {
        return canSpawnAtDepth(this.maxDepth, currentDepth);
    }

    /** The depth a child spawned by an agent at `parentDepth` would live at. */
    childDepth(parentDepth: number): number {
        return parentDepth + 1;
    }
}
