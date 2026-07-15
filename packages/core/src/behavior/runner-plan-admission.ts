/**
 * Deterministic runner plan-admission gate (plan Task 8).
 *
 * The runner workflow must reject missing, malformed, unapproved, or incomplete
 * plans BEFORE any task delegation. The `admit-plan` graph node's systemPrompt
 * instructs the model to apply this contract; this module is the deterministic,
 * testable expression of the same checks so admission can be proven without a
 * live provider turn and so the contract has one source of truth.
 *
 * A plan is admitted iff it: is non-empty, carries the structurally-required
 * scaffold sections, has at least one `- [ ]` todo checkbox, and is marked
 * approved/ready. Otherwise it is rejected with a machine-readable code and a
 * single clear human reason. Rejection is terminal for the run path: the graph
 * routes a rejected plan to `plan-rejected-terminal`, never to `delegate-wave`.
 */
import { parsePlanChecklistText } from '../persistence/plan-store';

/**
 * Scaffold section headers the runner admission gate requires a plan to carry.
 * These are the structurally-meaningful subset of the planner scaffold: the
 * runner parses `## Todos` and verifies against `## Final Verification Wave`,
 * while `## TL;DR` and `## Scope` prove the file is a scaffold plan (not a
 * stray markdown note). A plan missing any of them is malformed for execution.
 */
export const RUNNER_REQUIRED_SCAFFOLD_SECTIONS: readonly string[] = [
    '## TL;DR',
    '## Scope',
    '## Todos',
    '## Final Verification Wave',
];

/**
 * Matches a plan status marker indicating the plan was approved/ready for
 * execution. The planner's write-plan node emits `Status: Approved` after the
 * approval gate opens; `Ready` and `Accepted` are equivalent signals. The
 * runner admission gate treats absence of any marker as "unapproved" so a draft
 * that was never explicitly approved cannot reach task delegation.
 */
export const RUNNER_APPROVED_STATUS_PATTERN = /status\s*:\s*(approved|ready|accepted)/iu;

/** Machine-readable reason a plan was rejected at admission. */
export type PlanAdmissionCode = 'plan_empty' | 'missing_section' | 'no_todos' | 'not_approved';

export type PlanAdmissionResult =
    | { readonly admitted: true }
    | { readonly admitted: false; readonly reason: string; readonly code: PlanAdmissionCode };

/**
 * Deterministic structural admission check for a runner plan. Pure function:
 * given the plan markdown text, returns `{ admitted: true }` when the plan
 * carries every required scaffold section, at least one todo checkbox, and an
 * approved/ready status marker. Otherwise returns `{ admitted: false, reason,
 * code }` with a single clear reason.
 *
 * Order is intentional: empty first (cheapest), then scaffold sections, then
 * todos, then the approval marker. Each rejection names exactly one blocker so
 * the failure event stays high-signal.
 */
export function evaluatePlanAdmission(planText: string): PlanAdmissionResult {
    if (planText.trim() === '') {
        return { admitted: false, reason: 'plan is empty or missing', code: 'plan_empty' };
    }
    for (const section of RUNNER_REQUIRED_SCAFFOLD_SECTIONS) {
        if (!planText.includes(section)) {
            return {
                admitted: false,
                reason: `plan is missing required scaffold section: ${section}`,
                code: 'missing_section',
            };
        }
    }
    const checklist = parsePlanChecklistText(planText);
    if (checklist.total === 0) {
        return {
            admitted: false,
            reason: 'plan has no todo checkboxes under ## Todos',
            code: 'no_todos',
        };
    }
    if (!RUNNER_APPROVED_STATUS_PATTERN.test(planText)) {
        return {
            admitted: false,
            reason: 'plan is not marked approved/ready (no Status: Approved|Ready|Accepted marker)',
            code: 'not_approved',
        };
    }
    return { admitted: true };
}
