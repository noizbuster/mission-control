/**
 * `ast_grep` tool schemas (Wave 4, task 12 / checkbox #14).
 *
 * Input + output contracts plus a model-facing JSON Schema. The tool in
 * `ast-grep-tool.ts` supports two modes:
 *
 * - `query` (default, parity-bounded): calls `runAstGrep` (task 11) with
 *   workspace-rooted cwd and a cancellation signal. Returns structured
 *   matches. `AstGrepMatch` is reused verbatim from the runner so the
 *   structured output preserves the runner's normalised 1-indexed positions
 *   and flattened metaVariables.
 * - `rewrite`: calls the N-API `astRewrite` (dry-run, task 8) to compute
 *   structural replacements WITHOUT writing, then registers the apply
 *   closure on the session-scoped `StagedPreviewRegistry` (task 12).
 *   `resolve` is the only commit path. The query output shape is unchanged
 *   so existing callers observe no contract drift.
 */
import { z } from 'zod';
import type { AstGrepMatch } from './ast-grep-runner.js';

export type AstGrepInput = {
    readonly pattern: string;
    readonly paths: readonly string[];
    readonly language?: string;
    /** `'query'` (default) returns matches; `'rewrite'` proposes replacements
     * via the staged-preview registry. When omitted, the tool queries. */
    readonly mode?: 'query' | 'rewrite';
    /** Required when `mode` is `'rewrite'`: the ast-grep rewrite template.
     * Meta-variables captured in `pattern` are substituted. Ignored in query
     * mode. */
    readonly replacement?: string;
};

/** Query-mode output. Shape is locked by task 11/12 parity — do not alter. */
export type AstGrepQueryOutput = {
    readonly matches: readonly AstGrepMatch[];
    readonly filesSearched: number;
    readonly filesWithMatches: number;
    readonly truncated: boolean;
    readonly parseErrors?: readonly string[];
};

/** One file's proposed replacements, surfaced for resolve reporting. */
export type AstGrepReplacement = {
    readonly path: string;
    readonly count: number;
};

/** Rewrite-preview output. Mirrors the ast_edit propose shape so `resolve`
 * can assert propose-count == apply-count after the fact. */
export type AstGrepRewriteOutput = {
    readonly mode: 'rewrite';
    readonly proposed: number;
    readonly files: number;
    readonly replacements: readonly AstGrepReplacement[];
    readonly staged: boolean;
    readonly message: string;
};

export type AstGrepOutput = AstGrepQueryOutput | AstGrepRewriteOutput;

const astGrepMatchSchema = z
    .object({
        path: z.string().min(1),
        text: z.string(),
        startLine: z.number().int().nonnegative(),
        startColumn: z.number().int().nonnegative(),
        endLine: z.number().int().nonnegative(),
        endColumn: z.number().int().nonnegative(),
        metaVariables: z.record(z.string(), z.string()).optional(),
    })
    .strict();

const astGrepReplacementSchema = z
    .object({
        path: z.string().min(1),
        count: z.number().int().nonnegative(),
    })
    .strict();

export const astGrepInputSchema = z
    .object({
        pattern: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
        language: z.string().min(1).optional(),
        mode: z.enum(['query', 'rewrite']).optional(),
        replacement: z.string().optional(),
    })
    .strict();

/** Query-output schema (strict, parity-locked). */
const astGrepQueryOutputSchema = z
    .object({
        matches: z.array(astGrepMatchSchema),
        filesSearched: z.number().int().nonnegative(),
        filesWithMatches: z.number().int().nonnegative(),
        truncated: z.boolean(),
        parseErrors: z.array(z.string()).optional(),
    })
    .strict();

/** Rewrite-output schema (strict). */
const astGrepRewriteOutputSchema = z
    .object({
        mode: z.literal('rewrite'),
        proposed: z.number().int().nonnegative(),
        files: z.number().int().nonnegative(),
        replacements: z.array(astGrepReplacementSchema),
        staged: z.boolean(),
        message: z.string().min(1),
    })
    .strict();

/** Union schema accepts either the query shape or the rewrite shape. The
 * query branch has no `mode` field, so existing callers that parse a
 * `{matches,...,truncated}` object succeed unchanged. */
export const astGrepOutputSchema = z.union([astGrepQueryOutputSchema, astGrepRewriteOutputSchema]);

export function astGrepParametersJsonSchema(): Readonly<Record<string, unknown>> {
    return {
        type: 'object',
        properties: {
            pattern: {
                type: 'string',
                description:
                    'ast-grep structural pattern using tree-sitter syntax (e.g. "console.log($X)", "function $NAME($$$ARGS) { $$$BODY }").',
            },
            paths: {
                type: 'array',
                items: { type: 'string' },
                description: 'Files or directories to search, relative to the workspace root.',
            },
            language: {
                type: 'string',
                description:
                    'Optional language override (e.g. TypeScript, Rust). When omitted, ast-grep infers from file extensions.',
            },
            mode: {
                type: 'string',
                enum: ['query', 'rewrite'],
                description:
                    "'query' (default) returns structural matches. 'rewrite' proposes structural replacements via a staged preview (pairs with the resolve tool); requires 'replacement'.",
            },
            replacement: {
                type: 'string',
                description:
                    'Rewrite template for rewrite mode. Meta-variables ($X, $$$ARGS) are substituted. Required when mode is rewrite; ignored in query mode.',
            },
        },
        required: ['pattern', 'paths'],
        additionalProperties: false,
    };
}
