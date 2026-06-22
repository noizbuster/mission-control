/**
 * `task` tool — delegate a sub-task to a CHILD coding-agent graph run (ABG §10.6, Phase 6
 * deferred item).
 *
 * The tool itself is a thin contract: it validates the delegation prompt and forwards it to
 * an injected `spawn` function. The spawn function (wired by the runtime, which holds the
 * model resolver + tool list) builds the child graph with a CHILD permission policy
 * (`subagents/child-policy.ts` drops destructive `bash`/`write`/`patch`) and a CHILD tool
 * registry built via `createChildToolRegistry` — which always EXCLUDES the `task` tool. That
 * exclusion is the registry-layer recursion guard (ABG §10.6): a delegated subagent cannot
 * spawn further subagents, and unlike a permission rule it cannot be bypassed by a prompt.
 *
 * The `task` tool is therefore never present in a child's tool surface, so the depth is
 * structurally bounded at one level regardless of what the model emits.
 */
import { z } from 'zod';
import { isChildSafeCapability } from '../behavior/subagents/child-policy.js';
import { ToolRegistry } from './tool-registry.js';
import type { ToolRegistration } from './tool-registry-types.js';
import { ToolExecutionError } from './tool-registry-types.js';
import { truncateOutput, withContinuationHint } from './truncate.js';

const DEFAULT_SUMMARY_LIMIT = 4000;

const taskInputSchema = z.object({
    description: z.string().min(1).max(200),
    prompt: z.string().min(1),
});
export type TaskInput = z.infer<typeof taskInputSchema>;

const taskOutputSchema = z.object({
    description: z.string(),
    status: z.enum(['completed', 'failed']),
    summary: z.string(),
});
export type TaskOutput = z.infer<typeof taskOutputSchema>;

/** A spawn function builds + runs the child graph and returns its outcome. */
export type TaskSpawnFn = (input: TaskInput, context: { readonly signal: AbortSignal }) => Promise<TaskOutput>;

export type CreateTaskToolInput = {
    readonly spawn: TaskSpawnFn;
    readonly summaryLimit?: number;
};

/**
 * Build the `task` tool registration. The `spawn` closure captures the runtime's model
 * resolver + parent tool list so the tool's `execute` (which only receives `toolCallId`/
 * `toolName`/`signal`) can still delegate to a full child run.
 *
 * @deprecated Use `createFullParityTaskToolRegistration` from `./task/task-tool.js` with the simple-syntax shim instead.
 * The simple task tool is a legacy surface that will be removed in v3.
 */
export function createTaskToolRegistration(input: CreateTaskToolInput): ToolRegistration<TaskInput, TaskOutput> {
    const summaryLimit = input.summaryLimit ?? DEFAULT_SUMMARY_LIMIT;
    return {
        name: 'task',
        description:
            'Delegate a self-contained sub-task to a child agent with a read-only tool surface. ' +
            'Use for isolated research or analysis; the child cannot run bash/write or spawn further tasks.',
        capabilityClasses: ['subagent'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                description: { type: 'string', description: 'Short label for the delegated sub-task.' },
                prompt: { type: 'string', description: 'The full instruction for the child agent.' },
            },
            required: ['description', 'prompt'],
            additionalProperties: false,
        },
        inputSchema: taskInputSchema,
        outputSchema: taskOutputSchema,
        outputLimit: { maxModelOutputChars: summaryLimit + 200 },
        execute: async (toolInput, context) => {
            try {
                return await input.spawn(toolInput, { signal: context.signal });
            } catch (error) {
                throw new ToolExecutionError({
                    code: 'tool_failed',
                    message: `task "${toolInput.description}" failed: ${error instanceof Error ? error.message : String(error)}`,
                    retryable: false,
                });
            }
        },
        toModelOutput: (output) =>
            withContinuationHint(
                truncateOutput(output.summary, summaryLimit),
                output.status === 'failed'
                    ? 'the child agent failed; revise the delegation or do the work directly'
                    : '',
            ),
    };
}

/** The canonical tool name so the recursion guard is not a magic string. */
export const TASK_TOOL_NAME = 'task';

/**
 * Build a CHILD tool registry from the parent registry: every tool whose capability set is
 * child-safe (no destructive kind) EXCEPT the `task` tool itself. This is the registry-layer
 * recursion guard — the `task` tool is structurally absent from children, so a delegated
 * subagent cannot spawn further subagents regardless of what it emits.
 *
 * Operates on the type-erased registry (clones entries directly) so a heterogeneous parent
 * surface is filtered without re-asserting each registration's Input/Output generics.
 */
export function createChildToolRegistry(parentRegistry: ToolRegistry): ToolRegistry {
    return parentRegistry.cloneWithFilter(
        (advertisement) =>
            advertisement.name !== TASK_TOOL_NAME && isChildSafeCapability(advertisement.capabilityClasses),
    );
}
