import type { PolicyEffectRule, PolicyEffectRuleSet } from '@mission-control/protocol';

/**
 * Injected deny rule preventing a child session from spawning its own nested
 * subagents. Uses `**` so the deny applies regardless of the resource shape.
 */
const NESTED_SUBAGENT_DENY_RULE: PolicyEffectRule = {
    action: 'subagent',
    resource: '**',
    effect: 'deny',
};

/**
 * Derive the policy-gate ruleset for a child session spawned via `task()`.
 *
 * Semantics (ported from `temp/ref-repos/opencode/packages/opencode/src/agent/subagent-permissions.ts`):
 *
 * 1. **Denies inherit.** Every `deny` rule from the parent agent ruleset and
 *    the parent session ruleset is forwarded. This prevents a child from
 *    bypassing a restriction that was placed on the parent.
 * 2. **Nested-task deny.** A trailing `{action: 'subagent', effect: 'deny'}`
 *    rule is appended so the child cannot recursively spawn its own subagents.
 * 3. **Allows intersect implicitly.** Only denies are forwarded; the child's
 *    own allow rules are evaluated first, then this derived ruleset is appended.
 *    Because evaluation is last-match-wins, forwarded denies override any
 *    conflicting child allow — effectively intersecting the child's allows with
 *    the parent's restrictions.
 */
export function deriveChildPermissions(
    parentAgentRules: PolicyEffectRuleSet,
    parentSessionRules: PolicyEffectRuleSet,
): PolicyEffectRuleSet {
    const parentAgentDenies = parentAgentRules.rules.filter((rule) => rule.effect === 'deny');
    const parentSessionDenies = parentSessionRules.rules.filter((rule) => rule.effect === 'deny');

    return {
        rules: [...parentAgentDenies, ...parentSessionDenies, NESTED_SUBAGENT_DENY_RULE],
    };
}
