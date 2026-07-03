/**
 * `goal` tool - goal-mode hidden control surface.
 *
 * Ported from oh-my-pi (MIT). A hidden tool activated only in goal mode that
 * lets the model create, inspect, complete, resume, or drop a goal with an
 * optional token budget. The original delegates to a `GoalRuntime` obtained
 * from the session and throws when goal mode is inactive; this port replaces
 * the runtime lookup with an injectable `runtime` option and degrades to a
 * `not_active` outcome (rather than throwing) so the tool surface is safe to
 * register even when goal mode is off.
 *
 * Ported from arktype to Zod and stripped of the TUI renderer concerns, which
 * are not part of the core tool surface.
 */
import { z } from 'zod';
import { ToolRegistry } from './tool-registry.js';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types.js';

/** The canonical tool name so registry lookups avoid magic strings. */
export const GOAL_TOOL_NAME = 'goal';

export const GOAL_OPS = ['create', 'get', 'complete', 'resume', 'drop'] as const;
export type GoalOp = (typeof GOAL_OPS)[number];

export const GOAL_STATUSES = ['active', 'complete', 'budget-limited', 'paused', 'dropped'] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

// Schemas precede the types so z.infer can ground them; this avoids the
// exactOptionalPropertyTypes drift between hand-written and zod-inferred optionals.
const goalStateSchema = z
    .object({
        objective: z.string(),
        status: z.enum(GOAL_STATUSES),
        tokensUsed: z.number(),
        tokenBudget: z.number().int().positive().optional(),
    })
    .strict();

const goalInputSchema = z
    .object({
        op: z.enum(GOAL_OPS),
        objective: z.string().min(1).optional(),
        token_budget: z.number().int().positive().optional(),
    })
    .strict();

const goalOutputSchema = z
    .object({
        status: z.enum([
            'not_active',
            'created',
            'active',
            'complete',
            'budget_limited',
            'resumed',
            'dropped',
            'no_goal',
        ]),
        goal: goalStateSchema.nullable(),
        message: z.string().min(1),
    })
    .strict();

export type GoalState = z.infer<typeof goalStateSchema>;
export type GoalToolInput = z.infer<typeof goalInputSchema>;
export type GoalToolOutput = z.infer<typeof goalOutputSchema>;
export type GoalToolStatus = GoalToolOutput['status'];

export type CreateGoalArgs = {
    readonly objective: string;
    readonly tokenBudget?: number;
};

/**
 * Injectable runtime seam. The live implementation (a future goal-mode runtime)
 * owns goal persistence, token accounting, and status transitions; the tool only
 * validates inputs, dispatches, and formats the model-facing output.
 */
export type GoalRuntime = {
    readonly createGoal: (args: CreateGoalArgs) => GoalState | Promise<GoalState>;
    readonly getGoal: () => GoalState | null | Promise<GoalState | null>;
    readonly completeGoal: () => GoalState | Promise<GoalState>;
    readonly resumeGoal: () => GoalState | Promise<GoalState>;
    readonly dropGoal: () => GoalState | null | Promise<GoalState | null>;
};

export type GoalToolOptions = {
    /** When absent, the tool reports goal mode inactive. */
    readonly runtime?: GoalRuntime;
};

const goalParametersJsonSchema = {
    type: 'object',
    properties: {
        op: { type: 'string', enum: [...GOAL_OPS], description: 'Goal operation to perform.' },
        objective: { type: 'string', description: 'Goal objective text (required when op=create).' },
        token_budget: {
            type: 'integer',
            exclusiveMinimum: 0,
            description: 'Optional positive-integer token budget for the goal.',
        },
    },
    required: ['op'],
    additionalProperties: false,
} as const;

const GOAL_OUTPUT_LIMIT = { maxModelOutputChars: 1500 } as const;

function describeGoal(goal: GoalState): string {
    const budgetText = goal.tokenBudget !== undefined ? ` / ${goal.tokenBudget} budget` : '';
    return `Goal: ${goal.objective}\nStatus: ${goal.status}\nTokens: ${goal.tokensUsed} used${budgetText}`;
}

function validateCreateParams(input: GoalToolInput): CreateGoalArgs {
    const objective = input.objective?.trim();
    if (objective === undefined || objective.length === 0) {
        return { objective: '' };
    }
    return input.token_budget !== undefined ? { objective, tokenBudget: input.token_budget } : { objective };
}

export function createGoalToolRegistration(
    options: GoalToolOptions = {},
): ToolRegistration<GoalToolInput, GoalToolOutput> {
    return {
        name: GOAL_TOOL_NAME,
        description:
            'Manage the active goal in goal mode: create, inspect, complete, resume, or drop it. ' +
            'Goal mode is a hidden, opt-in control surface.',
        capabilityClasses: ['read'],
        parametersJsonSchema: goalParametersJsonSchema,
        inputSchema: goalInputSchema,
        outputSchema: goalOutputSchema,
        outputLimit: GOAL_OUTPUT_LIMIT,
        execute: async (input) => {
            const runtime = options.runtime;
            if (runtime === undefined) {
                return {
                    status: 'not_active',
                    goal: null,
                    message: 'Goal mode is not active.',
                };
            }
            switch (input.op) {
                case 'create': {
                    const args = validateCreateParams(input);
                    if (args.objective.length === 0) {
                        return {
                            status: 'no_goal',
                            goal: null,
                            message: 'objective is required when op=create.',
                        };
                    }
                    const goal = await runtime.createGoal(args);
                    return { status: 'created', goal, message: describeGoal(goal) };
                }
                case 'get': {
                    const goal = await runtime.getGoal();
                    if (goal === null) {
                        return { status: 'no_goal', goal: null, message: 'No active goal.' };
                    }
                    return { status: 'active', goal, message: describeGoal(goal) };
                }
                case 'complete': {
                    const goal = await runtime.completeGoal();
                    return { status: 'complete', goal, message: describeGoal(goal) };
                }
                case 'resume': {
                    const goal = await runtime.resumeGoal();
                    return { status: 'resumed', goal, message: describeGoal(goal) };
                }
                case 'drop': {
                    const goal = await runtime.dropGoal();
                    return {
                        status: 'dropped',
                        goal,
                        message: goal === null ? 'Goal dropped.' : describeGoal(goal),
                    };
                }
                default: {
                    return {
                        status: 'no_goal',
                        goal: null,
                        message: `Unknown op: ${input.op}`,
                    };
                }
            }
        },
        toModelOutput: (output) =>
            output.goal !== null ? output.message : output.status === 'not_active' ? 'No active goal.' : output.message,
        guideline:
            'Use goal to manage the active goal in goal mode. Provide objective (and optional token_budget) ' +
            'when creating. Only active when goal mode is enabled.',
    };
}

export function registerGoalTool(registry: ToolRegistry, options: GoalToolOptions = {}): ToolAdvertisement {
    return registry.register(createGoalToolRegistration(options));
}
