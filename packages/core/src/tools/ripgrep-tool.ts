/**
 * `ripgrep` tool — fast content search via `rg` (Phase: omo `tools/grep/` port).
 *
 * Resolves a regex pattern against file contents under a workspace-pinned base using the `rg`
 * binary on PATH. Three output modes mirror omo's `grep` tool:
 *
 *   - `content`           → matching lines as `path:line:text` (default human format).
 *   - `files_with_matches`→ one file path per match-free line (default; cheap "where").
 *   - `count`             → `count   path` per file.
 *
 * The static `ripgrepToolRegistration` resolves its base via `process.cwd()` / absolute paths and
 * performs no workspace guard. Registering it bare would expose an unguarded filesystem search
 * (escape outside the workspace, into reference repos). The factory in `ripgrep-tool-factory.ts`
 * is the production entry point: it pins the base to the workspace root, rejects absolute and
 * symlink-escape targets, applies the SAME denylist the read tools use, and stays read-class.
 *
 * The tool name stays `ripgrep`. It is distinct from the legacy `repo.search` registration and
 * the `grep` alias to `repo.search`. Agents that declare `tools: [read, ls, grep, find, ...]`
 * inherit `ripgrep` via the alias switch in `child-tool-permissions.ts`.
 */
import { z } from 'zod';
import type { ToolRegistration } from './tool-registry-types';
import { truncateOutput, withContinuationHint } from './truncate';

const DEFAULT_MAX_RESULTS = 200;
const OUTPUT_LIMIT_CHARS = 4000;

export type RipgrepOutputMode = 'content' | 'files_with_matches' | 'count';

export const ripgrepInputSchema = z.object({
    pattern: z.string().min(1),
    include: z.string().min(1).optional(),
    path: z.string().min(1).optional(),
    output_mode: z.enum(['content', 'files_with_matches', 'count']).optional(),
    head_limit: z.number().int().positive().optional(),
});
export type RipgrepToolInput = z.infer<typeof ripgrepInputSchema>;

/**
 * Structured output the factory's `execute` returns. The model-facing string is produced by
 * `formatRipgrepModelOutput` so the registry can settle the call with both shapes.
 */
export type RipgrepToolOutput = {
    readonly outputMode: RipgrepOutputMode;
    readonly matches: readonly RipgrepMatch[];
    readonly filesSearched: number;
    readonly truncated: boolean;
    /** Set when `rg` is unavailable or errored before invocation produced any matches. */
    readonly error?: string | undefined;
};

export type RipgrepMatch = {
    readonly path: string;
    /** 1-based when known; `0` for `files_with_matches` rows that carry no line context. */
    readonly line: number;
    readonly text: string;
};

export const ripgrepOutputSchema = z.object({
    outputMode: z.enum(['content', 'files_with_matches', 'count']),
    matches: z.array(
        z.object({
            path: z.string(),
            line: z.number().int(),
            text: z.string(),
        }),
    ),
    filesSearched: z.number().int(),
    truncated: z.boolean(),
    error: z.string().optional(),
});
export type RipgrepToolOutputParsed = z.infer<typeof ripgrepOutputSchema>;

export const ripgrepParametersJsonSchema = {
    type: 'object',
    properties: {
        pattern: {
            type: 'string',
            description: 'Regex pattern to search for in file contents (ripgrep syntax).',
        },
        include: {
            type: 'string',
            description: 'Optional file-pattern glob filter (e.g. "*.ts", "*.{ts,tsx}"). Forwarded to `rg --glob`.',
        },
        path: {
            type: 'string',
            description: 'Base directory to search from, workspace-relative. Defaults to the workspace root.',
        },
        output_mode: {
            type: 'string',
            enum: ['content', 'files_with_matches', 'count'],
            description:
                'Output shape: "content" returns matching lines, "files_with_matches" returns file paths only (default), "count" returns per-file match counts.',
        },
        head_limit: {
            type: 'integer',
            description: `Limit output to the first N entries (default ${DEFAULT_MAX_RESULTS}). 0 or omitted means no limit.`,
        },
    },
    required: ['pattern'],
    additionalProperties: false,
} as const;

export const ripgrepOutputLimit = { maxModelOutputChars: OUTPUT_LIMIT_CHARS } as const;

/**
 * Default output ceiling. Matches omo's 256KB cap and 60s timeout; the structured output is
 * further bounded by `head_limit`/`maxMatches` so the model-facing text stays under
 * `OUTPUT_LIMIT_CHARS`.
 */
export const RIPGREP_DEFAULT_MAX_OUTPUT_BYTES = 256 * 1024;
export const RIPGREP_DEFAULT_TIMEOUT_MS = 60_000;
export const RIPGREP_DEFAULT_HEAD_LIMIT = DEFAULT_MAX_RESULTS;

export function formatRipgrepModelOutput(output: RipgrepToolOutput): string {
    if (output.error !== undefined) {
        return `Error: ${output.error}`;
    }
    if (output.matches.length === 0) {
        return 'No matches found';
    }

    if (output.outputMode === 'count') {
        const total = output.matches.reduce((sum, match) => sum + match.line, 0);
        const header = `Found ${total} match(es) in ${output.matches.length} file(s):`;
        const body = output.matches
            .map((match) => `${String(match.line).padStart(6)} ${match.path}`)
            .join('\n');
        return withContinuationHint(
            truncateOutput(`${header}\n\n${body}`, OUTPUT_LIMIT_CHARS - 64),
            output.truncated ? 'narrow the pattern, add include glob, or lower head_limit for more' : '',
        );
    }

    const filesOnly = output.outputMode === 'files_with_matches';
    const header = `Found ${output.matches.length} match(es) in ${output.filesSearched} file(s)`;
    const groups = new Map<string, readonly RipgrepMatch[]>();
    for (const match of output.matches) {
        const existing = groups.get(match.path) ?? [];
        groups.set(match.path, [...existing, match]);
    }
    const blocks: string[] = [header, ''];
    for (const [path, matches] of groups) {
        blocks.push(path);
        if (!filesOnly) {
            for (const match of matches) {
                if (match.line === 0 && match.text.trim() === '') {
                    continue;
                }
                blocks.push(`  ${match.line}: ${match.text.trim()}`);
            }
        }
        blocks.push('');
    }
    return withContinuationHint(
        truncateOutput(blocks.join('\n'), OUTPUT_LIMIT_CHARS - 64),
        output.truncated ? 'narrow the pattern, add include glob, or lower head_limit for more' : '',
    );
}

/**
 * Static registration. Mirrors `globToolRegistration`: useful for tests and dry runs that don't
 * need workspace containment. Production callers should use `registerRipgrepTool` from
 * `ripgrep-tool-factory.ts` instead.
 *
 * The default `execute` here throws so accidental bare registration surfaces loudly. The factory
 * overrides it with a workspace-guarded implementation.
 */
export const ripgrepToolRegistration: ToolRegistration<RipgrepToolInput, RipgrepToolOutput> = {
    name: 'ripgrep',
    description:
        'Fast content search tool with safety limits (60s timeout, 256KB output). Searches file contents using regular expressions via ripgrep. Supports --include glob filtering and three output modes: "content" (matching lines), "files_with_matches" (file paths only, default), "count" (per-file match counts).',
    capabilityClasses: ['read'],
    parametersJsonSchema: ripgrepParametersJsonSchema,
    inputSchema: ripgrepInputSchema,
    outputSchema: ripgrepOutputSchema,
    outputLimit: { maxModelOutputChars: OUTPUT_LIMIT_CHARS },
    execute: async () => {
        throw new Error(
            "ripgrep tool registered without a workspace guard. Use registerRipgrepTool() from './ripgrep-tool-factory' instead.",
        );
    },
    toModelOutput: formatRipgrepModelOutput,
};
