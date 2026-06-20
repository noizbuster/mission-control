/**
 * `ast_grep` tool registration (Wave 4, task 12).
 *
 * Wraps `runAstGrep` from task 11 behind the `ToolRegistration` surface.
 * The tool is read-class: structural search with no side effects. Runner
 * errors (binary not installed, timeout, non-zero exit) surface as
 * `retryable: true` ToolExecutionError so the provider loop can re-attempt.
 * The runner function is injectable via `AstGrepToolOptions.runner` so unit
 * tests can exercise execute/toModelOutput without spawning processes.
 */
import type { z } from 'zod';
import type { AstGrepMatch } from './ast-grep-runner.js';
import { type AstGrepResult, type AstGrepRunOptions, runAstGrep } from './ast-grep-runner.js';
import {
    type AstGrepInput,
    type AstGrepOutput,
    astGrepInputSchema,
    astGrepOutputSchema,
    astGrepParametersJsonSchema,
} from './ast-grep-schemas.js';
import { type ToolAdvertisement, ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry.js';

const TRUNCATION_MARKER = 'result_truncated';

export type AstGrepRunnerFn = (options: AstGrepRunOptions) => Promise<AstGrepResult>;

export type AstGrepToolOptions = {
    readonly workspaceRoot: string;
    readonly runner?: AstGrepRunnerFn;
};

export async function registerAstGrepTool(
    registry: ToolRegistry,
    options: AstGrepToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(createAstGrepToolRegistration(options));
}

export function createAstGrepToolRegistration(
    options: AstGrepToolOptions,
): ToolRegistration<AstGrepInput, AstGrepOutput> {
    return {
        name: 'ast_grep',
        description:
            'Search code structurally using ast-grep patterns. Supports 50+ languages via tree-sitter. Use for finding code patterns that text search cannot express.',
        capabilityClasses: ['read'],
        parametersJsonSchema: astGrepParametersJsonSchema(),
        // exactOptionalPropertyTypes: hand-written types omit `| undefined` on optional fields; Zod infers it.
        inputSchema: astGrepInputSchema as z.ZodType<AstGrepInput>,
        outputSchema: astGrepOutputSchema as z.ZodType<AstGrepOutput>,
        outputLimit: { maxModelOutputChars: 8000 },
        execute: (input, context) => executeAstGrep(input, context, options),
        toModelOutput: astGrepModelOutput,
        guideline:
            'Use ast_grep for structural code search when grep is insufficient. Patterns use tree-sitter syntax: function declarations, method calls, type annotations, etc.',
    };
}

async function executeAstGrep(
    input: AstGrepInput,
    context: { readonly signal: AbortSignal },
    options: AstGrepToolOptions,
): Promise<AstGrepOutput> {
    const runner: AstGrepRunnerFn = options.runner ?? runAstGrep;
    const runOptions: AstGrepRunOptions = {
        pattern: input.pattern,
        paths: input.paths,
        ...(input.language !== undefined ? { language: input.language } : {}),
        cwd: options.workspaceRoot,
        signal: context.signal,
    };
    try {
        const result = await runner(runOptions);
        return {
            matches: result.matches,
            filesSearched: result.filesSearched,
            filesWithMatches: result.filesWithMatches,
            truncated: hasTruncationNotice(result.parseErrors),
            ...(result.parseErrors !== undefined && result.parseErrors.length > 0
                ? { parseErrors: result.parseErrors }
                : {}),
        };
    } catch (error: unknown) {
        if (error instanceof ToolExecutionError) {
            throw error;
        }
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: `ast_grep failed: ${errorMessage(error)}`,
            retryable: true,
        });
    }
}

function astGrepModelOutput(output: AstGrepOutput): string {
    if (output.matches.length === 0) {
        const lines = ['ast_grep: no matches found.'];
        appendParseErrors(lines, output.parseErrors);
        return lines.join('\n');
    }
    const header = `ast_grep: ${output.matches.length} match(es) across ${output.filesWithMatches} file(s).`;
    const blocks = output.matches.map((match) => formatMatch(match));
    const parts = [header, ...blocks];
    if (output.truncated) {
        parts.push('Result truncated by match limit. Narrow the pattern or paths to see more.');
    }
    appendParseErrors(parts, output.parseErrors);
    return parts.join('\n\n');
}

function formatMatch(match: AstGrepMatch): string {
    const location = `${match.path}:${match.startLine}:${match.startColumn}`;
    const lines = [`${location}: ${match.text}`];
    if (match.metaVariables !== undefined) {
        const entries = Object.entries(match.metaVariables);
        if (entries.length > 0) {
            const metaBlock = entries.map(([key, value]) => `  ${key}: ${value}`).join('\n');
            lines.push(metaBlock);
        }
    }
    return lines.join('\n');
}

function hasTruncationNotice(parseErrors: readonly string[] | undefined): boolean {
    if (parseErrors === undefined) return false;
    return parseErrors.some((line) => line.startsWith(TRUNCATION_MARKER));
}

function appendParseErrors(lines: string[], parseErrors: readonly string[] | undefined): void {
    if (parseErrors === undefined || parseErrors.length === 0) return;
    const filtered = parseErrors.filter((line) => !line.startsWith(TRUNCATION_MARKER));
    if (filtered.length > 0) {
        lines.push(filtered.join('\n'));
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
