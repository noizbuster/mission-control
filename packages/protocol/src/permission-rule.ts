import { z } from 'zod';

/**
 * Policy-gate effect rules for workflow-level permission algebra.
 *
 * These are DISTINCT from {@linkcode import('./permission-profile.js').PermissionRuleSchema} (the
 * workspace permission store shape `{permission, pattern, decision, workspaceRoot?}`). Policy-gate
 * rules use an action/resource/effect vocabulary that maps to the ABG policy-gate node and the
 * rule evaluator in `packages/core/src/permissions/`. The two schemas coexist intentionally; do
 * not collapse them.
 */

export const POLICY_EFFECTS = ['allow', 'deny', 'ask'] as const;
export const PolicyEffectSchema = z.enum(POLICY_EFFECTS);
export type PolicyEffect = z.infer<typeof PolicyEffectSchema>;

/**
 * A single declarative rule: "when `action` targets `resource`, resolve to `effect`".
 *
 * `action` is a capability-style verb (`'edit'`, `'write'`, `'bash'`, `'*'`). `resource` is a
 * glob-style pattern (`'src/*'`, `'**'`, `'.omo/plans/**'`). Evaluation is last-match-wins with
 * wildcard matching (see Task 1.2 `rule-evaluator.ts`).
 */
export const PolicyEffectRuleSchema = z
    .object({
        action: z.string().min(1),
        resource: z.string().min(1),
        effect: PolicyEffectSchema,
    })
    .strict();
export type PolicyEffectRule = z.infer<typeof PolicyEffectRuleSchema>;

/** A named ruleset grouping multiple {@linkcode PolicyEffectRuleSchema} entries. */
export const PolicyEffectRuleSetSchema = z
    .object({
        id: z.string().min(1).optional(),
        rules: z.array(PolicyEffectRuleSchema).default([]),
    })
    .strict();
export type PolicyEffectRuleSet = z.infer<typeof PolicyEffectRuleSetSchema>;
