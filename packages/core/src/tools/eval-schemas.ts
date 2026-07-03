/**
 * Zod schemas and JSON-Schema parameters for the `eval` tool (Task 19 / 22).
 *
 * Input is one or more cells in either a persistent JavaScript VM
 * (`language: 'js'`, `node:worker_threads` + `node:vm`) or a persistent Python
 * kernel subprocess (`language: 'py'`). State persists across cells of the same
 * language within one invocation; both runtimes share a common prelude that
 * exposes read-only agent tools (`read`, `grep`, ...) through the tool re-entry
 * bridge. Each cell carries optional per-cell timeout and title. Output is one
 * result per input cell with captured stdout/stderr, exit code, truncation flag,
 * and timeout flag.
 */

import { z } from 'zod';

export const evalLanguageSchema = z.enum(['js', 'py']);
export type EvalLanguage = z.infer<typeof evalLanguageSchema>;

export const evalCellSchema = z
    .object({
        language: evalLanguageSchema,
        code: z.string().min(1),
        timeoutMs: z.number().int().positive().optional(),
        title: z.string().min(1).optional(),
        /** Wipe this cell's language kernel before running; other languages are untouched. */
        reset: z.boolean().optional(),
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
                            enum: ['js', 'py'],
                            description:
                                "Cell runtime: 'js' for the persistent JS VM (node:worker_threads), 'py' for the persistent Python kernel subprocess.",
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
                        reset: {
                            type: 'boolean',
                            description:
                                'Wipe this cell language kernel before running (state of the other language is untouched).',
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
