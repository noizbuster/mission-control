/**
 * Zod schemas and JSON-Schema parameters for the `eval` tool (Task 22).
 *
 * Input is one or more JS cells (language is locked to `'js'`); each cell carries
 * optional per-cell timeout and title. Output is one result per input cell with
 * captured stdout/stderr, exit code, truncation flag, and timeout flag.
 */

import { z } from 'zod';

export const evalCellSchema = z
    .object({
        language: z.literal('js'),
        code: z.string().min(1),
        timeoutMs: z.number().int().positive().optional(),
        title: z.string().min(1).optional(),
    })
    .strict();

export type EvalCell = z.infer<typeof evalCellSchema>;

export const evalInputSchema = z
    .object({
        cells: z.array(evalCellSchema).min(1),
    })
    .strict();

export type EvalInput = z.infer<typeof evalInputSchema>;

export const evalCellResultSchema = z.object({
    title: z.string().optional(),
    output: z.string(),
    exitCode: z.number().int(),
    truncated: z.boolean(),
    timedOut: z.boolean(),
});

export type EvalCellResult = z.infer<typeof evalCellResultSchema>;

export const evalOutputSchema = z.object({
    results: z.array(evalCellResultSchema),
});

export type EvalOutput = z.infer<typeof evalOutputSchema>;

export function evalParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            cells: {
                type: 'array',
                description:
                    'JavaScript cells to execute in a persistent sandbox. State persists across cells within one call.',
                items: {
                    type: 'object',
                    properties: {
                        language: {
                            type: 'string',
                            enum: ['js'],
                            description: "Cell language. Only 'js' is supported.",
                        },
                        code: {
                            type: 'string',
                            description: 'JavaScript source to evaluate.',
                        },
                        timeoutMs: {
                            type: 'integer',
                            description: 'Per-cell timeout in milliseconds (default 30000).',
                        },
                        title: {
                            type: 'string',
                            description: 'Optional human-readable cell title for output formatting.',
                        },
                    },
                    required: ['language', 'code'],
                    additionalProperties: false,
                },
            },
        },
        required: ['cells'],
        additionalProperties: false,
    };
}
