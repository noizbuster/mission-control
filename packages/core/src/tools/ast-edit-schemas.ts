/**
 * `ast_edit` tool schemas (Wave 4, task 12).
 *
 * `ast_edit` proposes N structural replacements via the N-API ast module
 * (`astRewrite`, task 8) WITHOUT writing — it returns `(proposed) N
 * replacements` and stages the apply through the session-scoped
 * {@link StagedPreviewRegistry}. `resolve` is the only commit path.
 *
 * The structured output intentionally carries `proposed` (the count) and the
 * per-file `replacements` breakdown so `resolve` can assert propose-count ==
 * apply-count after the fact (the adversarial "misleading success" guard).
 */
import { z } from 'zod';

export type AstEditReplacement = {
    readonly path: string;
    readonly count: number;
};

export type AstEditInput = {
    readonly pattern: string;
    readonly replacement: string;
    readonly paths: readonly string[];
    readonly language?: string;
};

export type AstEditOutput = {
    /** Total proposed replacements across all files (the "(proposed) N" count). */
    readonly proposed: number;
    /** Number of distinct files with at least one proposed replacement. */
    readonly files: number;
    readonly replacements: readonly AstEditReplacement[];
    /** True when a preview was staged for `resolve`; false for 0 replacements. */
    readonly staged: boolean;
    readonly message: string;
};

const astEditReplacementSchema = z
    .object({
        path: z.string().min(1),
        count: z.number().int().nonnegative(),
    })
    .strict();

export const astEditInputSchema = z
    .object({
        pattern: z.string().min(1),
        replacement: z.string(),
        paths: z.array(z.string().min(1)).min(1),
        language: z.string().min(1).optional(),
    })
    .strict();

export const astEditOutputSchema = z
    .object({
        proposed: z.number().int().nonnegative(),
        files: z.number().int().nonnegative(),
        replacements: z.array(astEditReplacementSchema),
        staged: z.boolean(),
        message: z.string().min(1),
    })
    .strict();

export function astEditParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                description: 'ast-grep structural pattern to match (tree-sitter syntax, e.g. "console.log($X)").',
            },
            replacement: {
                type: 'string',
                description:
                    'Replacement template. Meta-variables captured in the pattern ($X, $$$ARGS) are substituted. Empty string deletes matches.',
            },
            paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Files or directories to rewrite, relative to the workspace root.',
            },
            language: {
                type: 'string',
                description:
                    'Optional language override (e.g. TypeScript). When omitted, ast-grep infers from file extensions.',
            },
        },
        required: ['pattern', 'replacement', 'paths'],
        additionalProperties: false,
    };
}
