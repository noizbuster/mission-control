/**
 * `yield` tool — child-agent result submission.
 *
 * Child agents call `yield` to submit their final result. The tool validates the
 * submitted `result` against the agent's optional `output` schema (declared on
 * the AgentDefinition) and returns a stop-now confirmation. The runtime (wired
 * separately in ConcreteTaskToolRuntime, todo 22) emits a YieldSignal to
 * terminate the child session loop; this tool validates and returns only.
 *
 * `findings` is an optional array accepted at the input boundary; the runtime
 * splices it into the parent's findings. The tool itself does not merge.
 *
 * Capability class `'yield'` is intentionally NOT in
 * {@linkcode ../../behavior/subagents/child-policy.js CHILD_DROPPED_CAPABILITY_KINDS}
 * — children SHOULD keep yield. It is the one capability that terminates a child.
 */
import { z } from 'zod';
import { ToolExecutionError, type ToolRegistration } from '../tool-registry-types.js';

/** The canonical tool name so registry lookups avoid magic strings. */
export const YIELD_TOOL_NAME = 'yield';

const YIELD_OUTPUT_LIMIT = { maxModelOutputChars: 2000 } as const;

export const yieldInputSchema = z
    .object({
        result: z.unknown(),
        findings: z.array(z.unknown()).optional(),
    })
    .strict();

const yieldOutputSchema = z
    .object({
        status: z.enum(['submitted']),
        message: z.string(),
    })
    .strict();

export type YieldToolParams = z.infer<typeof yieldInputSchema>;
export type YieldToolResult = z.infer<typeof yieldOutputSchema>;

export type CreateYieldToolOptions = {
    /** Agent `output` schema; when present, `result` is validated against it. */
    readonly outputSchema?: z.ZodType;
};

/**
 * Build the `yield` tool registration. The optional `outputSchema` closure
 * captures the agent's declared output contract so `execute` (which receives
 * only the parsed input) can validate the result without additional wiring.
 */
export function createYieldToolRegistration(
    options: CreateYieldToolOptions,
): ToolRegistration<YieldToolParams, YieldToolResult> {
    return {
        name: YIELD_TOOL_NAME,
        description: 'Submit your final result. Call this when your task is complete.',
        capabilityClasses: ['yield'],
        parametersJsonSchema: {
            type: 'object',
            properties: {
                result: {
                    description: 'The final result to submit. Must match the agent output schema if one is defined.',
                },
                findings: {
                    type: 'array',
                    description: 'Optional findings to splice into the parent findings array.',
                },
            },
            required: ['result'],
            additionalProperties: false,
        },
        inputSchema: yieldInputSchema,
        outputSchema: yieldOutputSchema,
        outputLimit: YIELD_OUTPUT_LIMIT,
        execute: async (input) => {
            if (options.outputSchema !== undefined) {
                const parseResult = options.outputSchema.safeParse(input.result);
                if (!parseResult.success) {
                    throw new ToolExecutionError({
                        code: 'schema_invalid',
                        message: `yield result does not match agent output schema: ${parseResult.error.message}`,
                        retryable: true,
                    });
                }
            }
            return { status: 'submitted', message: 'Result submitted. You can stop now.' };
        },
        toModelOutput: () => 'Result submitted. You can stop now.',
        guideline:
            'Call yield to submit your result when done. The result must match the output schema if one is defined.',
    };
}
