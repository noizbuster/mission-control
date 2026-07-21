/**
 * Full-parity `task()` tool — Task 1.8.
 *
 * Extends the existing simple `task` tool (`../task-tool.ts`) with category
 * routing, skill injection, session resume, and background execution. The tool
 * validates parameters, resolves the category preset, derives child permissions,
 * and delegates session lifecycle to an
 * injected `TaskToolRuntime` — keeping the tool itself free of real provider
 * calls so tests can mock everything.
 *
 * Child authority is completed by `buildChildToolSurface` in the concrete runtime. It intersects
 * category and agent tool allowlists, depth-gates nested `task` (PRODUCTION_MAX_TASK_DEPTH),
 * applies hard capability drops, adds `yield`, and enforces category plus derived agent
 * path-policy rules at invocation time. Nested-subagent deny is omitted only when depth allows.
 *
 * Batch mode (todo 24): `tasks[]` fan-out alongside single-spawn `prompt`.
 * Schema enforces XOR between batch and single-spawn; children run in parallel
 * via Promise.all; `context` propagates as `parentContext` to every child.
 */
import { TASK_TOOL_NAME } from '../task-tool';
import type { ToolRegistration } from '../tool-registry-types';
import { ToolExecutionError } from '../tool-registry-types';
import {
    type BatchResultItem,
    type BatchTaskItem,
    type ChildSpawnResult,
    type CreateFullParityTaskToolOptions,
    type TaskToolParams,
    type TaskToolResult,
    type TaskToolRuntime,
    taskToolInputSchema,
    taskToolOutputSchema,
} from './task-tool-contract';
import {
    buildBatchRequest,
    buildChildPermissions,
    buildRequest,
    resolveRouting,
    resolveRoutingFromAgent,
} from './task-tool-routing';

export type {
    BatchResultItem,
    BatchTaskItem,
    ChildSpawnFailureKind,
    ChildSpawnRequest,
    ChildSpawnResult,
    CreateFullParityTaskToolOptions,
    TaskToolBackgroundHandle,
    TaskToolParams,
    TaskToolResult,
    TaskToolRuntime,
} from './task-tool-contract';
export {
    batchTaskItemSchema,
    CHILD_SPAWN_FAILURE_KINDS,
    taskToolBaseObjectSchema,
    taskToolInputSchema,
} from './task-tool-contract';

const OUTPUT_LIMIT = { maxModelOutputChars: 8000 } as const;

// --- Registration factory --------------------------------------------------

export function createFullParityTaskToolRegistration(
    options: CreateFullParityTaskToolOptions,
): ToolRegistration<TaskToolParams, TaskToolResult> {
    return {
        name: TASK_TOOL_NAME,
        description:
            'Delegate a sub-task to a child agent session. Route by category for preset ' +
            'model/permissions/tools, or specify subagent_type directly. Supports background ' +
            'execution and session resume. Nested task() is allowed up to depth 3 ' +
            '(MAIN→child→grandchild→great-grandchild leaf). Pass tasks[] for batch fan-out ' +
            '(mutually exclusive with prompt/assignment).',
        capabilityClasses: ['subagent'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                category: {
                    type: 'string',
                    description: 'Category id: quick, deep, reasoner, explore, oracle, etc.',
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
                title: {
                    type: 'string',
                    description: 'Optional human title for the child session (1-200 chars).',
                },
                tasks: {
                    type: 'array',
                    description: 'Batch fan-out: one child per item. Mutually exclusive with prompt/assignment.',
                    items: {
                        type: 'object',
                        properties: {
                            agent: { type: 'string', description: 'Category id or subagent type for this child.' },
                            assignment: { type: 'string', description: 'Instruction for this child.' },
                            role: { type: 'string', description: 'Optional label surfaced in the batch summary.' },
                            title: {
                                type: 'string',
                                description: 'Optional human title for this child session (1-200 chars).',
                            },
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
        execute: async (input, context) => {
            if (input.tasks !== undefined) {
                return executeBatch(input.tasks, input.context, options.runtime, context);
            }

            const routing = resolveRouting(input);
            const childPermissions = buildChildPermissions(routing.category);

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
                    buildRequest({
                        params: input,
                        routing,
                        sessionId: input.task_id,
                        childPermissions,
                        signal: context.signal,
                        ...(context.controlEpoch !== undefined ? { controlEpoch: context.controlEpoch } : {}),
                    }),
                );
                return toToolResult(result, context.signal);
            }

            const sessionId = options.runtime.generateSessionId();
            const request = buildRequest({
                params: input,
                routing,
                sessionId,
                childPermissions,
                signal: context.signal,
                ...(context.controlEpoch !== undefined ? { controlEpoch: context.controlEpoch } : {}),
            });

            if (input.run_in_background === true) {
                const handle = options.runtime.startBackgroundSession(request);
                return { sessionId: handle.sessionId, backgroundId: handle.backgroundId, status: 'running' };
            }

            return toToolResult(await options.runtime.runChildSession(request), context.signal);
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
            '(deep=full, explore=read-only, reasoner=opus). Nested task() is bounded to depth 3. ' +
            'Set run_in_background=true for async work; pass task_id to resume an existing session. ' +
            'Pass tasks[] to fan out a parallel batch (each item has its own agent+assignment); ' +
            'optional context is forwarded to every child.',
    };
}

async function executeBatch(
    tasks: readonly BatchTaskItem[],
    context: string | undefined,
    runtime: TaskToolRuntime,
    toolContext: import('../tool-registry-types').ToolExecutionContext,
): Promise<TaskToolResult> {
    const items: BatchResultItem[] = [];
    for (let waveStart = 0; waveStart < tasks.length; waveStart += 4) {
        const waveItems = await Promise.all(
            tasks.slice(waveStart, waveStart + 4).map(async (item): Promise<BatchResultItem> => {
                const sessionId = runtime.generateSessionId();
                const routing = resolveRoutingFromAgent(item.agent);
                const childPermissions = buildChildPermissions(routing.category);
                const request = buildBatchRequest({
                    item,
                    sessionId,
                    childPermissions,
                    parentContext: context,
                    signal: toolContext.signal,
                    ...(toolContext.controlEpoch !== undefined ? { controlEpoch: toolContext.controlEpoch } : {}),
                });
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
        items.push(...waveItems);
    }
    return {
        sessionId: items[0]?.sessionId ?? 'batch_empty',
        status: 'completed',
        batch: items,
    };
}

function toToolResult(result: ChildSpawnResult, signal?: AbortSignal): TaskToolResult {
    if (result.status === 'failed') {
        if (signal?.aborted === true) {
            throw new ToolExecutionError({
                code: 'operator_aborted',
                message: result.output,
                retryable: false,
            });
        }
        const failure = classifyChildSpawnFailure(result);
        throw new ToolExecutionError({
            code: failure.code,
            message: result.output,
            retryable: failure.retryable,
        });
    }
    return { sessionId: result.sessionId, status: result.status, output: result.output };
}

export function classifyChildSpawnFailure(result: ChildSpawnResult): {
    readonly code: 'task_yield_missing' | 'task_child_failed' | 'operator_aborted' | 'tool_failed';
    readonly retryable: boolean;
} {
    const kind = result.failureKind;
    if (kind === 'yield_missing') {
        return { code: 'task_yield_missing', retryable: true };
    }
    if (kind === 'aborted') {
        return { code: 'operator_aborted', retryable: false };
    }
    if (kind === 'tool_denied') {
        return { code: 'tool_failed', retryable: false };
    }
    if (kind === 'graph_failed') {
        return { code: 'task_child_failed', retryable: false };
    }
    if (result.output.startsWith('[degraded salvage]')) {
        return { code: 'task_yield_missing', retryable: true };
    }
    return { code: 'tool_failed', retryable: false };
}
