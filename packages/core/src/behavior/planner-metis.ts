/**
 * Pure gap-analysis reject-budget routing for the planner post-floor gap analysis.
 *
 * `routeMetisReject` is the only authority for `metis.reject_route`
 * (`revise` | `escalate_present`). Budget is a named counter (`metis.rejects`),
 * not global `maxNodeRuns`. Default budget is 1: first reject revises the draft;
 * second reject escalates to present-blocked.
 *
 * Session-sticky for the planner run. T6 resets the counter to 0 when the
 * dual-fix revise path re-enters so a dual-fix rewrite gets one fresh gap-analysis chance.
 */

/** Named Gap-analysis reject budget (first reject revises; second escalates). */
export const PLANNER_METIS_REJECT_BUDGET = 1;

/** Equals-routed `metis.reject_route` labels (bi-coverage vocabulary). */
export const METIS_REJECT_ROUTE_VALUES = ['revise', 'escalate_present'] as const;
export type MetisRejectRoute = (typeof METIS_REJECT_ROUTE_VALUES)[number];

/**
 * Authority for `metis.reject_route`:
 * - rejects < budget → `revise` (caller increments `metis.rejects`)
 * - rejects >= budget → `escalate_present` (present-blocked terminal)
 *
 * Budget defaults to {@linkcode PLANNER_METIS_REJECT_BUDGET} (1).
 */
export function routeMetisReject(rejects: number, budget: number = PLANNER_METIS_REJECT_BUDGET): MetisRejectRoute {
    if (rejects >= budget) {
        return 'escalate_present';
    }
    return 'revise';
}
