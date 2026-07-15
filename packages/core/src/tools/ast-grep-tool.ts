/**
 * `ast_grep` tool registration (Wave 4, task 12 / checkbox #14).
 *
 * Two modes share this tool surface:
 *
 * - **query** (default, read-class, parity-bounded): structural search via
 *   `runAstGrep` from task 11. Returns structured matches with no side
 *   effects. Runner errors (binary not installed, timeout, non-zero exit)
 *   surface as `retryable: true` ToolExecutionError.
 *
 * - **rewrite-preview** (checkbox #14): structural rewrite proposal via the
 *   N-API `astRewrite` (dry-run, task 8). Computes `NativeAstReplaceChange[]`
 *   WITHOUT writing, then registers the apply closure on the session-scoped
 *   {@link StagedPreviewRegistry} (task 12). `resolve` is the ONLY commit
 *   path. The tool itself stays read-class: it proposes, resolve commits.
 *
 * The runner function (query) and the rewriter function (rewrite-preview) are
 * both injectable so unit tests exercise execute/toModelOutput without
 * spawning processes or the native addon.
 *
 * Advertisement parity with oh-my-pi (MIT, Can Bölük / Mario Zechner): the
 * description frames both modes and the language-detection default so the
 * model knows it can search structurally OR propose a rewrite in one call.
 */
import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import type { z } from 'zod';
import { createNativesClient } from '../native/natives-client';
import {
    type AstEditReplacement,
    type AstRewriteFn,
    applyStagedAstEdit,
    createDefaultAstRewriter,
} from './ast-edit';
import {
    type AstGrepMatch,
    type AstGrepResult,
    type AstGrepRunOptions,
    defaultAstSearchFileCollector,
    runAstGrep,
} from './ast-grep-runner';
import {
    type AstGrepInput,
    type AstGrepOutput,
    type AstGrepQueryOutput,
    type AstGrepReplacement,
    type AstGrepRewriteOutput,
    astGrepInputSchema,
    astGrepOutputSchema,
    astGrepParametersJsonSchema,
} from './ast-grep-schemas';
import { createPatchWorkspaceGuard } from './file-patch-paths';
import { type StagedPreviewAction, type StagedPreviewRegistry } from './staged-preview-registry';
import { type ToolAdvertisement, ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry';
import { relative } from 'node:path';

const TRUNCATION_MARKER = 'result_truncated';
const AST_GREP_TOOL_NAME = 'ast_grep';

export type AstGrepRunnerFn = (options: AstGrepRunOptions) => Promise<AstGrepResult>;

export type AstGrepToolOptions = {
    readonly workspaceRoot: string;
    readonly runner?: AstGrepRunnerFn;
    /** Session-scoped registry shared with `resolve`. Required for the
     * rewrite-preview mode; ignored in query mode. */
    readonly registry?: StagedPreviewRegistry;
    /** Dry-run rewriter for rewrite-preview mode. Defaults to
     * {@link createDefaultAstRewriter} over a `NativesClient`. */
    readonly rewriter?: AstRewriteFn;
    /** Optional write-approval callback invoked at apply time (after
     * staleness re-validation, before a write). Mirrors ast_edit's gate. */
    readonly requestPermission?: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    /** Injectable file collector for rewrite-preview (defaults to the
     * workspace-vetted walker shared with the query path). */
    readonly collectFiles?: (cwd: string, paths: readonly string[]) => Promise<readonly string[]>;
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
        name: AST_GREP_TOOL_NAME,
        description:
            'Search code structurally using ast-grep patterns (50+ languages via tree-sitter). Two modes:\n' +
            '- query (default): structural search returning matches. Use when syntax shape matters more than raw text ' +
            '(calls, declarations, imports). Language is inferred from file extensions when not specified.\n' +
            '- rewrite: propose structural replacements via a staged preview. Pass mode:"rewrite" and a replacement template ' +
            '(meta-variables like $X are substituted). Returns (proposed) N replacements WITHOUT writing; call ' +
            'resolve(action:"apply") to commit or resolve(action:"discard") to drop.\n' +
            'Patterns use tree-sitter syntax: $NAME captures one node, $$$ARGS captures zero-or-more, $_ matches without binding.',
        capabilityClasses: ['read'],
        parametersJsonSchema: astGrepParametersJsonSchema(),
        // exactOptionalPropertyTypes: hand-written types omit `| undefined` on optional fields; Zod infers it.
        inputSchema: astGrepInputSchema as z.ZodType<AstGrepInput>,
        outputSchema: astGrepOutputSchema as z.ZodType<AstGrepOutput>,
        outputLimit: { maxModelOutputChars: 8000 },
        execute: (input, context) => executeAstGrep(input, context, options),
        toModelOutput: astGrepModelOutput,
        guideline:
            'Use ast_grep query mode for structural code search when grep is insufficient (function declarations, method calls, type annotations). ' +
            'Use ast_grep rewrite mode to propose structural refactors (rename calls, modernize syntax, swap imports) — it only PROPOSES; ' +
            'always follow with resolve to apply or discard. resolve is the only commit path.',
    };
}

async function executeAstGrep(
    input: AstGrepInput,
    context: { readonly signal: AbortSignal },
    options: AstGrepToolOptions,
): Promise<AstGrepOutput> {
    if (input.mode === 'rewrite') {
        return executeAstGrepRewrite(input, options);
    }
    return executeAstGrepQuery(input, context, options);
}

async function executeAstGrepQuery(
    input: AstGrepInput,
    context: { readonly signal: AbortSignal },
    options: AstGrepToolOptions,
): Promise<AstGrepQueryOutput> {
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

async function executeAstGrepRewrite(input: AstGrepInput, options: AstGrepToolOptions): Promise<AstGrepRewriteOutput> {
    if (options.registry === undefined) {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message:
                'ast_grep rewrite requires a StagedPreviewRegistry. Configure the registry to enable rewrite-preview mode.',
            retryable: false,
        });
    }
    if (input.replacement === undefined) {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: 'ast_grep rewrite requires a "replacement" template. Pass replacement alongside mode:"rewrite".',
            retryable: false,
        });
    }
    const replacement = input.replacement;

    const guard = await createPatchWorkspaceGuard(options.workspaceRoot);
    const rewriter: AstRewriteFn = options.rewriter ?? createDefaultAstRewriter(createNativesClient());
    const collectFiles = options.collectFiles ?? defaultAstSearchFileCollector;

    const files = await collectFiles(options.workspaceRoot, input.paths);
    if (files.length === 0) {
        return noReplacementResult();
    }

    let changes: ReturnType<AstRewriteFn>;
    try {
        changes = rewriter(input.pattern, files, {
            replacement,
            ...(input.language !== undefined ? { lang: input.language } : {}),
        });
    } catch (error: unknown) {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: `ast_grep rewrite failed: ${errorMessage(error)}`,
            retryable: true,
        });
    }

    if (changes.length === 0) {
        return noReplacementResult();
    }

    const replacements = summarizeReplacements(changes, options.workspaceRoot);
    const proposedCount = changes.length;

    const apply = (reason: string): Promise<readonly { readonly path: string; readonly count: number }[]> =>
        applyStagedAstEdit({
            reason,
            pattern: input.pattern,
            replacement,
            ...(input.language !== undefined ? { language: input.language } : {}),
            files,
            workspaceRoot: options.workspaceRoot,
            guard,
            rewriter,
            proposedCount,
            proposedReplacements: replacements as readonly AstEditReplacement[],
            ...(options.requestPermission !== undefined ? { requestPermission: options.requestPermission } : {}),
        });

    const action: StagedPreviewAction = {
        id: `${AST_GREP_TOOL_NAME}:rewrite:${proposedCount}`,
        summary: {
            label: `AST Grep Rewrite: ${proposedCount} replacement${proposedCount === 1 ? '' : 's'} in ${replacements.length} file${replacements.length === 1 ? '' : 's'}`,
            sourceToolName: AST_GREP_TOOL_NAME,
            proposedCount,
            files: replacements,
        },
        apply,
    };
    options.registry.register(action);

    const plural = proposedCount === 1 ? '' : 's';
    const filePlural = replacements.length === 1 ? '' : 's';
    return {
        mode: 'rewrite',
        proposed: proposedCount,
        files: replacements.length,
        replacements,
        staged: true,
        message:
            `(proposed) ${proposedCount} replacement${plural} in ${replacements.length} file${filePlural}. ` +
            'Call resolve(action:"apply", reason:"...") to commit, or resolve(action:"discard", reason:"...") to drop.',
    };
}

function astGrepModelOutput(output: AstGrepOutput): string {
    if (isRewriteOutput(output)) {
        return rewriteModelOutput(output);
    }
    return queryModelOutput(output);
}

function queryModelOutput(output: AstGrepQueryOutput): string {
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

function rewriteModelOutput(output: AstGrepRewriteOutput): string {
    if (output.proposed === 0) {
        return output.message;
    }
    const plural = output.proposed === 1 ? '' : 's';
    const lines = [`(proposed) ${output.proposed} replacement${plural} across ${output.files} file(s).`];
    for (const entry of output.replacements) {
        lines.push(`  ${entry.path}: ${entry.count}`);
    }
    lines.push('Call resolve(action:"apply") to commit, or resolve(action:"discard") to drop.');
    return lines.join('\n');
}

function isRewriteOutput(output: AstGrepOutput): output is AstGrepRewriteOutput {
    return typeof output === 'object' && output !== null && (output as AstGrepRewriteOutput).mode === 'rewrite';
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

function summarizeReplacements(
    changes: readonly { readonly path: string }[],
    workspaceRoot: string,
): readonly AstGrepReplacement[] {
    const counts = new Map<string, number>();
    const order: string[] = [];
    for (const change of changes) {
        const rel = toRelative(workspaceRoot, change.path);
        if (!counts.has(rel)) {
            order.push(rel);
            counts.set(rel, 0);
        }
        counts.set(rel, (counts.get(rel) ?? 0) + 1);
    }
    return order.map((path) => ({ path, count: counts.get(path) ?? 0 }));
}

function toRelative(workspaceRoot: string, absolutePath: string): string {
    const rel = relative(workspaceRoot, absolutePath);
    return rel.length === 0 ? absolutePath : rel;
}

function noReplacementResult(): AstGrepRewriteOutput {
    return {
        mode: 'rewrite',
        proposed: 0,
        files: 0,
        replacements: [],
        staged: false,
        message: 'ast_grep rewrite: no replacements proposed. Nothing staged for resolve.',
    };
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
