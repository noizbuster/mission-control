import { z } from 'zod';
import { type PolicyEffectRule, PolicyEffectRuleSchema } from './permission-rule.js';

/**
 * A declarative mode overlay applied to a workflow at materialization time (Task 3.8).
 *
 * A mode is NOT a prompt injection — it is a structural overlay: a system-prompt addendum merged
 * into llm-actor configs, a set of policy-gate rules added to `graph.policies`, and an optional
 * required-tools filter. Example: `autopilot` mode adds certainty/scenario/TDD directives and
 * policies that block edit-without-scenario and test deletion.
 */
export const ModeSchema = z
    .object({
        id: z.string().min(1),
        systemPromptOverlay: z.string().min(1).optional(),
        policies: z.array(PolicyEffectRuleSchema).default([]),
        requiredTools: z.array(z.string().min(1)).optional(),
    })
    .strict();
export type Mode = z.infer<typeof ModeSchema>;

/**
 * A Mission/Run's binding to a mode by id. `active` defaults to `true` so a declaration takes
 * effect unless explicitly toggled off; the runtime can flip it without dropping the binding.
 */
export const ModeDeclarationSchema = z
    .object({
        modeId: z.string().min(1),
        active: z.boolean().default(true),
    })
    .strict();
export type ModeDeclaration = z.infer<typeof ModeDeclarationSchema>;

export type { PolicyEffectRule };
