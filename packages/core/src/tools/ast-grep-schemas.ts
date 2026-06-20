/**
 * `ast_grep` tool schemas (Wave 4, task 12).
 *
 * Input + output contracts plus a model-facing JSON Schema. The tool in
 * `ast-grep-tool.ts` calls `runAstGrep` (task 11) with workspace-rooted cwd
 * and a cancellation signal. `AstGrepMatch` is reused verbatim from the
 * runner so the structured output preserves the runner's normalised
 * 1-indexed positions and flattened metaVariables.
 */
import { z } from 'zod';
import type { AstGrepMatch } from './ast-grep-runner.js';

export type AstGrepInput = {
    readonly pattern: string;
    readonly paths: readonly string[];
    readonly language?: string;
};

export type AstGrepOutput = {
    readonly matches: readonly AstGrepMatch[];
    readonly filesSearched: number;
    readonly filesWithMatches: number;
    readonly truncated: boolean;
    readonly parseErrors?: readonly string[];
};

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

export const astGrepInputSchema = z
    .object({
        pattern: z.string().min(1),
        paths: z.array(z.string().min(1)).min(1),
        language: z.string().min(1).optional(),
    })
    .strict();

export const astGrepOutputSchema = z
    .object({
        matches: z.array(astGrepMatchSchema),
        filesSearched: z.number().int().nonnegative(),
        filesWithMatches: z.number().int().nonnegative(),
        truncated: z.boolean(),
        parseErrors: z.array(z.string()).optional(),
    })
    .strict();

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
        },
        required: ['pattern', 'paths'],
        additionalProperties: false,
    };
}
