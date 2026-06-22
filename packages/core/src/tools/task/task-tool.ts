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
 *
 * Batch mode (todo 24): `tasks[]` fan-out alongside single-spawn `prompt`.
 * Schema enforces XOR between batch and single-spawn; children run in parallel
 * via Promise.all; `context` propagates as `parentContext` to every child.
 */
// allow: SIZE_OK — single responsibility (the full-parity task tool registration);
// the LOC growth comes from two mutually-exclusive execution modes (single-spawn
// XOR batch) that share routing/permission helpers. Splitting along the batch
// axis would fragment the schema and the ToolRegistration factory, which are
// inseparable. Tracked for revisit if a third mode is added.
import type { PolicyEffectRule, PolicyEffectRuleSet } from '@mission-control/protocol';
import { z } from 'zod';
import { deriveChildPermissions } from '../../permissions/rule-derive.js';
import { TASK_TOOL_NAME } from '../task-tool.js';
import type { ToolRegistration } from '../tool-registry-types.js';
import { ToolExecutionError } from '../tool-registry-types.js';
import { type CategoryDefinition, getCategory } from './category-catalog.js';

// --- Schemas + public types ------------------------------------------------

export const batchTaskItemSchema = z
    .object({
        agent: z.string().min(1),
        assignment: z.string().min(1),
        role: z.string().optional(),
    })
    .strict();

export const taskToolBaseObjectSchema = z
    .object({
        category: z.string().min(1).optional(),
        subagent_type: z.string().min(1).optional(),
        agent: z.string().min(1).optional(),
        load_skills: z.array(z.string().min(1)).default([]),
        prompt: z.string().min(1).optional(),
        assignment: z.string().min(1).optional(),
        run_in_background: z.boolean().optional(),
        task_id: z.string().min(1).optional(),
        tasks: z.array(batchTaskItemSchema).optional(),
        context: z.string().optional(),
    })
    .strict();

export const taskToolInputSchema = taskToolBaseObjectSchema
    .refine((data) => !(data.category !== undefined && data.subagent_type !== undefined), {
        message: "Provide either 'category' or 'subagent_type', not both",
    })
    .refine((data) => [data.category, data.subagent_type, data.agent].filter((v) => v !== undefined).length <= 1, {
        message: "Provide at most one of 'category', 'subagent_type', or 'agent'",
    })
    .refine((data) => !(data.prompt !== undefined && data.assignment !== undefined), {
        message: "Provide either 'prompt' or 'assignment', not both",
    })
    .refine(
        (data) => {
            const hasBatch = data.tasks !== undefined;
            const hasSingle = data.prompt !== undefined || data.assignment !== undefined;
            return hasBatch !== hasSingle;
        },
        { message: "Provide either 'tasks' (batch) or 'prompt'/'assignment' (single), not both" },
    )
    .refine((data) => data.tasks === undefined || data.tasks.length > 0, {
        message: "'tasks' must contain at least one entry",
    });

const batchResultItemSchema = z
    .object({
        role: z.string().optional(),
        sessionId: z.string().min(1),
        status: z.enum(['completed', 'failed']),
        output: z.string(),
    })
    .strict();

const taskToolOutputSchema = z
    .object({
        sessionId: z.string().min(1),
        backgroundId: z.string().min(1).optional(),
        status: z.enum(['running', 'completed', 'failed']),
        output: z.string().optional(),
        batch: z.array(batchResultItemSchema).optional(),
    })
    .strict();

export type TaskToolParams = z.infer<typeof taskToolInputSchema>;
export type TaskToolResult = z.infer<typeof taskToolOutputSchema>;
export type BatchTaskItem = z.infer<typeof batchTaskItemSchema>;
export type BatchResultItem = z.infer<typeof batchResultItemSchema>;

// --- Runtime abstraction (mockable) ----------------------------------------

export interface ChildSpawnRequest {
    readonly sessionId: string;
    readonly prompt: string;
    readonly category?: CategoryDefinition;
    readonly subagentType?: string;
    readonly loadSkills: readonly string[];
    readonly childPermissions: readonly PolicyEffectRule[];
    readonly parentContext?: string;
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

function resolveRoutingFromAgent(agent: string): RoutingResolution {
    const matched = getCategory(agent);
    return matched !== undefined ? { category: matched, subagentType: agent } : { subagentType: agent };
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
        return resolveRoutingFromAgent(params.subagent_type);
    }
    if (params.agent !== undefined) {
        return resolveRoutingFromAgent(params.agent);
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
    parentContext?: string,
): ChildSpawnRequest {
    return {
        sessionId,
        prompt: params.prompt ?? params.assignment ?? '',
        loadSkills: params.load_skills,
        childPermissions,
        ...(routing.category !== undefined ? { category: routing.category } : {}),
        ...(routing.subagentType !== undefined ? { subagentType: routing.subagentType } : {}),
        ...(parentContext !== undefined ? { parentContext } : {}),
    };
}

function buildBatchRequest(
    item: BatchTaskItem,
    sessionId: string,
    childPermissions: readonly PolicyEffectRule[],
    parentContext: string | undefined,
): ChildSpawnRequest {
    const routing = resolveRoutingFromAgent(item.agent);
    return {
        sessionId,
        prompt: item.assignment,
        loadSkills: [],
        childPermissions,
        ...(routing.category !== undefined ? { category: routing.category } : {}),
        ...(routing.subagentType !== undefined ? { subagentType: routing.subagentType } : {}),
        ...(parentContext !== undefined ? { parentContext } : {}),
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
            'execution and session resume. Children cannot spawn nested tasks. Pass tasks[] ' +
            'for batch fan-out (mutually exclusive with prompt/assignment).',
        capabilityClasses: ['subagent'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                category: {
                    type: 'string',
                    description: 'Category id: quick, deep, ultrabrain, explore, oracle, etc.',
                },
                subagent_type: { type: 'string', description: 'Direct agent type (alternative to category).' },
                agent: {
                    type: 'string',
                    description: 'Alias for category/subagent_type (oh-my-pi convention).',
                },
                load_skills: { type: 'array', items: { type: 'string' }, description: 'Skill ids to pre-load.' },
                prompt: { type: 'string', description: 'The full instruction for the child agent (single-spawn).' },
                assignment: {
                    type: 'string',
                    description: 'Alias for prompt (oh-my-pi convention). Mutually exclusive with prompt.',
                },
                run_in_background: { type: 'boolean', description: 'Return a background id immediately.' },
                task_id: { type: 'string', description: 'Existing session id (ses_...) to resume.' },
                tasks: {
                    type: 'array',
                    description: 'Batch fan-out: one child per item. Mutually exclusive with prompt/assignment.',
                    items: {
                        type: 'object',
                        properties: {
                            agent: { type: 'string', description: 'Category id or subagent type for this child.' },
                            assignment: { type: 'string', description: 'Instruction for this child.' },
                            role: { type: 'string', description: 'Optional label surfaced in the batch summary.' },
                        },
                        required: ['agent', 'assignment'],
                        additionalProperties: false,
                    },
                },
                context: {
                    type: 'string',
                    description: 'Shared parent context forwarded to every child in batch mode.',
                },
            },
            additionalProperties: false,
        },
        inputSchema: taskToolInputSchema,
        outputSchema: taskToolOutputSchema,
        outputLimit: OUTPUT_LIMIT,
        execute: async (input) => {
            if (input.tasks !== undefined) {
                return executeBatch(input.tasks, input.context, parentAgent, parentSession, options.runtime);
            }

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
            if (output.batch !== undefined) {
                if (output.batch.length === 0) {
                    return 'Batch completed with no tasks.';
                }
                const lines = output.batch.map((item, index) => {
                    const label = item.role ?? `task ${index + 1}`;
                    const tail = item.output.length > 200 ? `${item.output.slice(0, 200)}...` : item.output;
                    return `${index + 1}. [${item.status}] ${label}: ${tail}`;
                });
                return `Batch of ${output.batch.length}:\n${lines.join('\n')}`;
            }
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
            'Set run_in_background=true for async work; pass task_id to resume an existing session. ' +
            'Pass tasks[] to fan out a parallel batch (each item has its own agent+assignment); ' +
            'optional context is forwarded to every child.',
    };
}

async function executeBatch(
    tasks: readonly BatchTaskItem[],
    context: string | undefined,
    parentAgent: PolicyEffectRuleSet,
    parentSession: PolicyEffectRuleSet,
    runtime: TaskToolRuntime,
): Promise<TaskToolResult> {
    const items = await Promise.all(
        tasks.map(async (item): Promise<BatchResultItem> => {
            const sessionId = runtime.generateSessionId();
            const routing = resolveRoutingFromAgent(item.agent);
            const childPermissions = buildChildPermissions(routing.category, parentAgent, parentSession);
            const request = buildBatchRequest(item, sessionId, childPermissions, context);
            try {
                const result = await runtime.runChildSession(request);
                return {
                    sessionId: result.sessionId,
                    status: result.status,
                    output: result.output,
                    ...(item.role !== undefined ? { role: item.role } : {}),
                };
            } catch (error: unknown) {
                const message = error instanceof Error ? error.message : String(error);
                return {
                    sessionId,
                    status: 'failed',
                    output: message,
                    ...(item.role !== undefined ? { role: item.role } : {}),
                };
            }
        }),
    );
    return {
        sessionId: items[0]?.sessionId ?? 'batch_empty',
        status: 'completed',
        batch: items,
    };
}

function toToolResult(result: ChildSpawnResult): TaskToolResult {
    return { sessionId: result.sessionId, status: result.status, output: result.output };
}
