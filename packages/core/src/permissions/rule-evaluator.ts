import type { PolicyEffect, PolicyEffectRule, PolicyEffectRuleSet } from '@mission-control/protocol';
import { wildcardMatch } from './wildcard-match.js';

/**
 * Result of evaluating policy-gate rules against a single action/resource pair.
 */
export interface EvaluationResult {
    /** The resolved effect: the matched rule's effect, or `'ask'` when no rule matches. */
    readonly effect: PolicyEffect;
    /** The last matching rule, absent when no rule matched. */
    readonly matchedRule?: PolicyEffectRule;
}

/**
 * Default effect returned when no rule matches any provided ruleset.
 *
 * Conservative by design: unresolved access defers to human approval.
 */
const DEFAULT_EFFECT: PolicyEffect = 'ask';

/**
 * Evaluate policy-gate permission rules using last-match-wins semantics.
 *
 * All rules from all rulesets are flattened in order. The LAST rule whose
 * `action` pattern matches `action` AND whose `resource` pattern matches
 * `resource` wins. If no rule matches, the result is `DEFAULT_EFFECT` (`'ask'`)
 * with no `matchedRule`.
 *
 * Ported from `temp/ref-repos/opencode/packages/core/src/permission.ts` (evaluate,
 * lines 102-112). Adapted for mission-control's `PolicyEffectRuleSet` shape
 * (`{id?, rules}`) which wraps the rule array, unlike opencode's bare `Rule[]`.
 */
export function evaluateRules(
    action: string,
    resource: string,
    rulesets: readonly PolicyEffectRuleSet[],
): EvaluationResult {
    const allRules = rulesets.flatMap((ruleset) => ruleset.rules);

    let matched: PolicyEffectRule | undefined;
    for (const rule of allRules) {
        if (wildcardMatch(rule.action, action) && wildcardMatch(rule.resource, resource)) {
            matched = rule;
        }
    }

    if (matched === undefined) {
        return { effect: DEFAULT_EFFECT };
    }
    return { effect: matched.effect, matchedRule: matched };
}
