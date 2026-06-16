/**
 * Mission + Run protocol schemas (ABG §11, Phase 7).
 *
 * A **Mission** is the saved, deployable agent definition: its ABG graph (or a graphId
 * reference), model defaults, budget, capabilities, and policies. A **Run** is ONE
 * execution instance of a Mission — the live record that links a graph execution to its
 * durable event timeline (sessionId), accumulated cost, and lifecycle status.
 *
 * Mission is to Run what a program is to a process. Missions are versioned + reusable;
 * Runs are ephemeral records (one per `runAbgGraph` invocation) that a Mission-Control
 * surface (Inspector/CLI) projects into an observable timeline.
 */
import { z } from 'zod';
import {
    type AbgGraphSpec,
    AbgGraphSpecSchema,
    type AbgNodeModelOptions,
    AbgNodeModelOptionsSchema,
    type AbgPolicySpec,
    AbgPolicySpecSchema,
} from './abg.js';

export const MISSION_STATUSES = ['draft', 'active', 'archived'] as const;
export const MissionStatusSchema = z.enum(MISSION_STATUSES);
export type MissionStatus = z.infer<typeof MissionStatusSchema>;

/**
 * The tool/capability surface a Mission is permitted to use. A list of capability
 * strings (e.g. `read`, `bash.run`, `file.write`) intersected with the workspace
 * PermissionRules at run time; capabilities not declared here are not advertised to the
 * model. Mirrors the ABG node `capabilities` field but at Mission granularity.
 */
export const MissionCapabilitiesSchema = z.object({
    allow: z.array(z.string().min(1)).default([]),
    deny: z.array(z.string().min(1)).default([]),
});
export type MissionCapabilities = z.infer<typeof MissionCapabilitiesSchema>;

export const MissionBudgetSchema = z.object({
    /** Hard ceiling in cents for a single Run of this Mission. `usage → policy.budget.*`
     * events surface accumulation; a Run exceeding this is routed to escalate/abort. */
    budgetCents: z.number().int().nonnegative(),
    /** Soft threshold (cents) at which a `policy.budget.warning` event fires (<= budgetCents). */
    warnAtCents: z.number().int().nonnegative().optional(),
});
export type MissionBudget = z.infer<typeof MissionBudgetSchema>;

export const MissionSchema = z
    .object({
        id: z.string().min(1),
        name: z.string().min(1),
        description: z.string().optional(),
        status: MissionStatusSchema.default('draft'),
        version: z.string().min(1).default('1'),
        /** Either an inline ABG graph spec or a reference to a registered graph by id. */
        graph: AbgGraphSpecSchema.optional(),
        graphId: z.string().min(1).optional(),
        model: AbgNodeModelOptionsSchema.optional(),
        capabilities: MissionCapabilitiesSchema.default({ allow: [], deny: [] }),
        policies: z.array(AbgPolicySpecSchema).default([]),
        budget: MissionBudgetSchema.optional(),
        createdAt: z.string().min(1),
        updatedAt: z.string().min(1),
    })
    .refine((mission) => mission.graph !== undefined || mission.graphId !== undefined, {
        message: 'Mission must declare either an inline graph or a graphId',
        path: ['graph'],
    });
export type Mission = z.infer<typeof MissionSchema>;

export const RUN_STATUSES = ['pending', 'running', 'blocked', 'completed', 'failed', 'cancelled'] as const;
export const RunStatusSchema = z.enum(RUN_STATUSES);
export type RunStatus = z.infer<typeof RunStatusSchema>;

/** Cost accumulated by a Run, fed by `usage → policy.budget.*` from the LLM actor node. */
export const RunCostSchema = z.object({
    cents: z.number().int().nonnegative().default(0),
    /** Running token totals (provider-agnostic buckets). */
    inputTokens: z.number().int().nonnegative().default(0),
    outputTokens: z.number().int().nonnegative().default(0),
    /** Number of model calls (LLM actor turns) executed. */
    modelCalls: z.number().int().nonnegative().default(0),
});
export type RunCost = z.infer<typeof RunCostSchema>;

export const RunSchema = z.object({
    id: z.string().min(1),
    missionId: z.string().min(1),
    status: RunStatusSchema.default('pending'),
    /** Links this Run to its durable event timeline (the JSONL session store). */
    sessionId: z.string().min(1).optional(),
    graphId: z.string().min(1).optional(),
    /** Resolved model the Run executed with (snapshot of the Mission's model selection). */
    model: AbgNodeModelOptionsSchema.optional(),
    cost: RunCostSchema.default(() => ({ cents: 0, inputTokens: 0, outputTokens: 0, modelCalls: 0 })),
    attempt: z.number().int().positive().default(1),
    startedAt: z.string().min(1).optional(),
    endedAt: z.string().min(1).optional(),
    /** Human/terminal reason for a terminal status (failure code, cancel cause, etc.). */
    terminalReason: z.string().optional(),
});
export type Run = z.infer<typeof RunSchema>;

export type { AbgGraphSpec, AbgNodeModelOptions, AbgPolicySpec };
