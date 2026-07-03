/**
 * `plan_exit` tool - plan-to-build handoff.
 *
 * Ported from opencode (MIT). The original is an Effect/Schema service that
 * asks the user whether to switch from the read-only plan agent to the build
 * agent and injects a synthetic user message ("the plan is approved, execute
 * it"). This port rewrites Effect -> plain async TypeScript and replaces the
 * opencode Session/Question/Provider services with an injectable `onSwitch`
 * callback so the tool stays free of runtime internals and testable in
 * isolation.
 *
 * The tool takes no parameters. `execute` resolves the plan path, builds the
 * handoff message, asks the host (via `onSwitch`) whether to approve, and
 * returns a switched/cancelled outcome. When no `onSwitch` callback is wired
 * the tool defaults to approved (the scaffold / non-interactive path), mirroring
 * the opencode "complete the demo with mock behavior" contract.
 */
import { z } from 'zod';
import { ToolRegistry } from './tool-registry.js';
import type { ToolAdvertisement, ToolRegistration } from './tool-registry-types.js';

/** The canonical tool name so registry lookups avoid magic strings. */
export const PLAN_EXIT_TOOL_NAME = 'plan_exit';

/** Outcome the host returns from the switch-request callback. */
export type PlanExitSwitchOutcome = {
    readonly approved: boolean;
};

/** Arguments passed to the `onSwitch` host callback. */
export type PlanExitSwitchArgs = {
    readonly planPath: string;
    readonly message: string;
};

export type PlanExitToolOptions = {
    /** Plan path relative to the worktree; surfaces in the handoff message. */
    readonly planPath?: string;
    /**
     * Host hook that performs the agent switch + synthetic-message injection.
     * Returning `{ approved: false }` keeps the plan agent. When omitted the
     * tool defaults to approved (scaffold/non-interactive path).
     */
    readonly onSwitch?: (args: PlanExitSwitchArgs) => PlanExitSwitchOutcome | Promise<PlanExitSwitchOutcome>;
};

export type PlanExitInput = Record<string, never>;

export type PlanExitOutput = {
    readonly status: 'switched' | 'cancelled';
    readonly agent: 'build' | 'plan';
    readonly planPath: string;
    readonly message: string;
};

const planExitInputSchema = z.object({}).strict();

const planExitOutputSchema = z
    .object({
        status: z.enum(['switched', 'cancelled']),
        agent: z.enum(['build', 'plan']),
        planPath: z.string(),
        message: z.string(),
    })
    .strict();

const planExitParametersJsonSchema = {
    type: 'object',
    properties: {},
    additionalProperties: false,
} as const;

const PLAN_EXIT_OUTPUT_LIMIT = { maxModelOutputChars: 1000 } as const;

function buildHandoffMessage(planPath: string): string {
    const resolved = planPath.length > 0 ? planPath : 'the plan';
    return `The plan at ${resolved} has been approved, you can now edit files. Execute the plan.`;
}

export function createPlanExitToolRegistration(
    options: PlanExitToolOptions = {},
): ToolRegistration<PlanExitInput, PlanExitOutput> {
    return {
        name: PLAN_EXIT_TOOL_NAME,
        description:
            'Use this tool when you have completed the planning phase and are ready to exit the plan agent. ' +
            'It asks the user whether to switch to the build agent and start implementing the plan.',
        capabilityClasses: ['read'],
        parametersJsonSchema: planExitParametersJsonSchema,
        inputSchema: planExitInputSchema,
        outputSchema: planExitOutputSchema,
        outputLimit: PLAN_EXIT_OUTPUT_LIMIT,
        execute: async () => {
            const planPath = options.planPath ?? '';
            const message = buildHandoffMessage(planPath);
            if (options.onSwitch === undefined) {
                return { status: 'switched', agent: 'build', planPath, message };
            }
            const outcome = await options.onSwitch({ planPath, message });
            if (outcome.approved) {
                return { status: 'switched', agent: 'build', planPath, message };
            }
            return {
                status: 'cancelled',
                agent: 'plan',
                planPath,
                message: 'User chose to stay with the plan agent to continue refining the plan.',
            };
        },
        toModelOutput: (output) =>
            output.status === 'switched' ? `Switching to build agent. ${output.message}` : 'Staying with plan agent.',
        guideline:
            'Call plan_exit once the plan is finalized and you are ready to hand off to the build agent. ' +
            'Do not call it before the plan is complete or while questions remain.',
    };
}

export function registerPlanExitTool(registry: ToolRegistry, options: PlanExitToolOptions = {}): ToolAdvertisement {
    return registry.register(createPlanExitToolRegistration(options));
}
