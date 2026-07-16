/**
 * Pure dual-review routing for the planner post-Metis high-accuracy path (plan T6).
 *
 * `routeDualReview` is the only authority for `dual.route` (`skip` | `run`).
 * `routeFixDual` is the only authority for `dual.fix_route` (`revise` | `escalate`)
 * with named counter `dual.fixes` and budget 1.
 *
 * Fail-closed: missing `intent` or `review_required` → `run`.
 * On dual-fix revise, the dual-fix-gate runner resets `metis.rejects` to 0
 * so a dual-fix rewrite gets one fresh Metis chance (decision 18).
 */

/** Named dual-fix budget (first REJECT revises; second escalates). */
export const PLANNER_DUAL_FIX_BUDGET = 1;

/** Equals-routed `dual.route` labels (bi-coverage vocabulary). */
export const DUAL_ROUTE_VALUES = ['skip', 'run'] as const;
export type DualRoute = (typeof DUAL_ROUTE_VALUES)[number];

/** Equals-routed `dual.fix_route` labels (bi-coverage vocabulary). */
export const DUAL_FIX_ROUTE_VALUES = ['revise', 'escalate'] as const;
export type DualFixRoute = (typeof DUAL_FIX_ROUTE_VALUES)[number];

/** Valid intent labels for dual-review skip/run (decision 16). */
export const DUAL_INTENT_VALUES = ['clear', 'unclear'] as const;
export type DualIntent = (typeof DUAL_INTENT_VALUES)[number];

export type RouteDualReviewInput = {
    readonly intent: string | undefined;
    readonly reviewRequired: boolean | undefined;
};

/**
 * Authority for `dual.route`:
 * - `skip` iff intent === 'clear' AND reviewRequired === false (both keys present)
 * - `run` if reviewRequired === true OR intent === 'unclear' OR either key missing
 *   (fail-closed to run)
 */
export function routeDualReview(input: RouteDualReviewInput): DualRoute {
    const { intent, reviewRequired } = input;
    if (intent === undefined || reviewRequired === undefined) {
        return 'run';
    }
    if (intent === 'clear' && reviewRequired === false) {
        return 'skip';
    }
    return 'run';
}

/**
 * Authority for `dual.fix_route` after dual.verdict REJECT:
 * - fixes < budget → `revise` (caller increments `dual.fixes`, resets metis.rejects)
 * - fixes >= budget → `escalate` (present-blocked terminal)
 *
 * Budget defaults to {@linkcode PLANNER_DUAL_FIX_BUDGET} (1).
 */
export function routeFixDual(fixes: number, budget: number = PLANNER_DUAL_FIX_BUDGET): DualFixRoute {
    if (fixes >= budget) {
        return 'escalate';
    }
    return 'revise';
}
