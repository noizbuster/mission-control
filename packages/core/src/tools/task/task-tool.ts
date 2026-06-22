/**
 * Full-parity `task()` tool — Task 1.8.
 *
 * Extends the existing simple `task` tool (`../task-tool.ts`) with category
 * routing, skill injection, session resume, and background execution. The tool
 * validates parameters, resolves the category preset, derives child permissions
 * via `deriveChildPermissions` (Task 1.2), and delegates session lifecycle to an
 * injected `TaskToolRuntime` — keeping the tool itself free of real provider
 * calls so tests can mock everything.
 *
 * Child safety is enforced at TWO layers (defense in depth):
 * 1. **Registry layer** — `createChildToolRegistry` (reused from `../task-tool.ts`)
 *    structurally omits the `task` tool and destructive/network capabilities.
 * 2. **Policy layer** — `deriveChildPermissions` injects a trailing
 *    `{action:'subagent', effect:'deny'}` rule so even if the tool existed it
 *    would be denied at the policy gate.
 */
import type { PolicyEffectRule, PolicyEffectRuleSet } from '@mission-control/protocol';
import { z } from 'zod';
import { deriveChildPermissions } from '../../permissions/rule-derive.js';
import { TASK_TOOL_NAME } from '../task-tool.js';
import type { ToolRegistration } from '../tool-registry-types.js';
import { ToolExecutionError } from '../tool-registry-types.js';
import { type CategoryDefinition, getCategory } from './category-catalog.js';

// --- Schemas + public types ------------------------------------------------

export const taskToolInputSchema = z
    .object({
        category: z.string().min(1).optional(),
        subagent_type: z.string().min(1).optional(),
        load_skills: z.array(z.string().min(1)).default([]),
        prompt: z.string().min(1),
        run_in_background: z.boolean().optional(),
        task_id: z.string().min(1).optional(),
    })
    .strict()
    .refine((data) => !(data.category !== undefined && data.subagent_type !== undefined), {
        message: "Provide either 'category' or 'subagent_type', not both",
    });

const taskToolOutputSchema = z
    .object({
        sessionId: z.string().min(1),
        backgroundId: z.string().min(1).optional(),
        status: z.enum(['running', 'completed', 'failed']),
        output: z.string().optional(),
    })
    .strict();

export type TaskToolParams = z.infer<typeof taskToolInputSchema>;
export type TaskToolResult = z.infer<typeof taskToolOutputSchema>;

// --- Runtime abstraction (mockable) ----------------------------------------

export interface ChildSpawnRequest {
    readonly sessionId: string;
    readonly prompt: string;
    readonly category?: CategoryDefinition;
    readonly subagentType?: string;
    readonly loadSkills: readonly string[];
    readonly childPermissions: readonly PolicyEffectRule[];
}

export interface ChildSpawnResult {
    readonly sessionId: string;
    readonly status: 'completed' | 'failed';
    readonly output: string;
}

export interface TaskToolBackgroundHandle {
    readonly sessionId: string;
    readonly backgroundId: string;
}

/**
 * Abstracts `AgentRuntime` session operations so the tool has no direct
 * dependency on provider calls. Tests inject a recording double; the real
 * runtime wires this to `AgentRuntime.start`/`runGraph`/session resume.
 */
export interface TaskToolRuntime {
    readonly runChildSession: (request: ChildSpawnRequest) => Promise<ChildSpawnResult>;
    readonly startBackgroundSession: (request: ChildSpawnRequest) => TaskToolBackgroundHandle;
    readonly resumeChildSession: (sessionId: string, request: ChildSpawnRequest) => Promise<ChildSpawnResult>;
    readonly sessionExists: (sessionId: string) => boolean;
    readonly generateSessionId: () => string;
}

export interface CreateFullParityTaskToolOptions {
    readonly runtime: TaskToolRuntime;
    readonly parentAgentRules?: PolicyEffectRuleSet;
    readonly parentSessionRules?: PolicyEffectRuleSet;
}

const EMPTY_RULESET: PolicyEffectRuleSet = { rules: [] };
const OUTPUT_LIMIT = { maxModelOutputChars: 8000 } as const;

// --- Routing + permission derivation ---------------------------------------

interface RoutingResolution {
    readonly category?: CategoryDefinition;
    readonly subagentType?: string;
}

function resolveRouting(params: TaskToolParams): RoutingResolution {
    if (params.category !== undefined) {
        const category = getCategory(params.category);
        if (category === undefined) {
            throw new ToolExecutionError({
                code: 'schema_invalid',
                message: `unknown category: ${params.category}`,
                retryable: true,
            });
        }
        return { category };
    }
    if (params.subagent_type !== undefined) {
        const matched = getCategory(params.subagent_type);
        return matched !== undefined
            ? { category: matched, subagentType: params.subagent_type }
            : { subagentType: params.subagent_type };
    }
    const fallback = getCategory('deep');
    return fallback !== undefined ? { category: fallback } : {};
}

function buildChildPermissions(
    category: CategoryDefinition | undefined,
    parentAgent: PolicyEffectRuleSet,
    parentSession: PolicyEffectRuleSet,
): readonly PolicyEffectRule[] {
    const derived = deriveChildPermissions(parentAgent, parentSession);
    // Category rules first; derived denies last (last-match-wins → inherited
    // restrictions always override category allows).
    return [...(category?.permissions ?? []), ...derived.rules];
}

function buildRequest(
    params: TaskToolParams,
    routing: RoutingResolution,
    sessionId: string,
    childPermissions: readonly PolicyEffectRule[],
): ChildSpawnRequest {
    return {
        sessionId,
        prompt: params.prompt,
        loadSkills: params.load_skills,
        childPermissions,
        ...(routing.category !== undefined ? { category: routing.category } : {}),
        ...(routing.subagentType !== undefined ? { subagentType: routing.subagentType } : {}),
    };
}

// --- Registration factory --------------------------------------------------

export function createFullParityTaskToolRegistration(
    options: CreateFullParityTaskToolOptions,
): ToolRegistration<TaskToolParams, TaskToolResult> {
    const parentAgent = options.parentAgentRules ?? EMPTY_RULESET;
    const parentSession = options.parentSessionRules ?? EMPTY_RULESET;

    return {
        name: TASK_TOOL_NAME,
        description:
            'Delegate a sub-task to a child agent session. Route by category for preset ' +
            'model/permissions/tools, or specify subagent_type directly. Supports background ' +
            'execution and session resume. Children cannot spawn nested tasks.',
        capabilityClasses: ['subagent'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                category: {
                    type: 'string',
                    description: 'Category id: quick, deep, ultrabrain, explore, oracle, etc.',
                },
                subagent_type: { type: 'string', description: 'Direct agent type (alternative to category).' },
                load_skills: { type: 'array', items: { type: 'string' }, description: 'Skill ids to pre-load.' },
                prompt: { type: 'string', description: 'The full instruction for the child agent.' },
                run_in_background: { type: 'boolean', description: 'Return a background id immediately.' },
                task_id: { type: 'string', description: 'Existing session id (ses_...) to resume.' },
            },
            required: ['prompt'],
            additionalProperties: false,
        },
        inputSchema: taskToolInputSchema,
        outputSchema: taskToolOutputSchema,
        outputLimit: OUTPUT_LIMIT,
        execute: async (input) => {
            const routing = resolveRouting(input);
            const childPermissions = buildChildPermissions(routing.category, parentAgent, parentSession);

            if (input.task_id !== undefined) {
                if (!options.runtime.sessionExists(input.task_id)) {
                    throw new ToolExecutionError({
                        code: 'tool_failed',
                        message: `session not found: ${input.task_id}`,
                        retryable: false,
                    });
                }
                const result = await options.runtime.resumeChildSession(
                    input.task_id,
                    buildRequest(input, routing, input.task_id, childPermissions),
                );
                return toToolResult(result);
            }

            const sessionId = options.runtime.generateSessionId();
            const request = buildRequest(input, routing, sessionId, childPermissions);

            if (input.run_in_background === true) {
                const handle = options.runtime.startBackgroundSession(request);
                return { sessionId: handle.sessionId, backgroundId: handle.backgroundId, status: 'running' };
            }

            return toToolResult(await options.runtime.runChildSession(request));
        },
        toModelOutput: (output) => {
            if (output.status === 'running') {
                return `Task started in background (session: ${output.sessionId}, id: ${output.backgroundId ?? 'n/a'}).`;
            }
            if (output.status === 'failed') {
                return `Task failed (session: ${output.sessionId}): ${output.output ?? 'unknown error'}`;
            }
            return output.output ?? `Task completed (session: ${output.sessionId}).`;
        },
        guideline:
            'Delegate a sub-task to a child agent. Use category to preset model/tools/permissions ' +
            '(deep=full, explore=read-only, ultrabrain=opus). Children cannot spawn nested tasks. ' +
            'Set run_in_background=true for async work; pass task_id to resume an existing session.',
    };
}

function toToolResult(result: ChildSpawnResult): TaskToolResult {
    return { sessionId: result.sessionId, status: result.status, output: result.output };
}
