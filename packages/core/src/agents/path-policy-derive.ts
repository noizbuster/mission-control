/**
 * Path-policy derivation for child agent sessions.
 *
 * Path policies are the agent-level resource gates declared on
 * {@linkcode AgentDefinition.pathPolicies}. They use the same
 * action/resource/effect vocabulary as workflow policy-gate rules
 * (see {@linkcode PolicyEffectRuleSchema}), but are scoped to individual
 * agent declarations rather than workflow graphs.
 *
 * These helpers bridge the agent-declaration model to the existing
 * policy evaluator ({@linkcode evaluateRules}), so child tool-surface
 * filtering and per-invocation gates can reuse the last-match-wins
 * wildcard evaluator without duplicating its logic.
 */
import type { AgentDefinition, PolicyEffectRule } from '@mission-control/protocol';
import { type EvaluationResult, evaluateRules } from '../permissions/rule-evaluator.js';

/**
 * Derive the effective path-policy list for a child agent.
 *
 * Semantics (mirrors {@linkcode deriveChildPermissions} from `rule-derive.ts`):
 *
 * 1. The child's own `pathPolicies` are preserved as-is (allows AND denies).
 * 2. Every `deny` rule from the parent's `pathPolicies` is appended, so
 *    inherited restrictions override conflicting child allows under
 *    last-match-wins evaluation.
 *
 * This prevents a child from escaping a path restriction that was placed
 * on the parent — e.g. if the parent denies `bash:**`, every child it
 * spawns also loses bash-capable tools regardless of the child's own
 * declarations.
 */
export function deriveChildPathPolicies(parent: AgentDefinition, child: AgentDefinition): PolicyEffectRule[] {
    const childPolicies = child.pathPolicies ?? [];
    const parentDenies = (parent.pathPolicies ?? []).filter((rule) => rule.effect === 'deny');
    return [...childPolicies, ...parentDenies];
}

/**
 * Evaluate a flat list of path-policy rules against a single action/resource pair.
 *
 * Thin wrapper over {@linkcode evaluateRules}: wraps the flat rule list as a
 * single anonymous ruleset (`{rules}`) and delegates to the existing
 * last-match-wins wildcard evaluator. Returns the resolved effect plus the
 * matched rule when one exists.
 */
export function evaluatePathPolicies(
    action: string,
    resource: string,
    rules: readonly PolicyEffectRule[],
): EvaluationResult {
    return evaluateRules(action, resource, [{ rules: [...rules] }]);
}
