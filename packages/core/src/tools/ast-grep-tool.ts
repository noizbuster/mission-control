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
import type { AstRewriteFn } from './ast-edit-rewriter';
import { AST_GREP_TOOL_NAME } from './ast-grep-identity';
import { astGrepModelOutput } from './ast-grep-output';
import { type AstGrepRunnerFn, executeAstGrepQuery } from './ast-grep-query';
import { executeAstGrepRewrite } from './ast-grep-rewrite';
import {
    type AstGrepInput,
    type AstGrepOutput,
    astGrepInputSchema,
    astGrepOutputSchema,
    astGrepParametersJsonSchema,
} from './ast-grep-schemas';
import type { StagedPreviewRegistry } from './staged-preview-registry';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry';

export type { AstGrepRunnerFn } from './ast-grep-query';

type AstGrepToolBaseOptions = {
    readonly workspaceRoot: string;
    readonly runner?: AstGrepRunnerFn;
    /** Dry-run rewriter for rewrite-preview mode. Defaults to
     * {@link createDefaultAstRewriter} over a `NativesClient`. */
    readonly rewriter?: AstRewriteFn;
    /** Injectable file collector for rewrite-preview (defaults to the
     * workspace-vetted walker shared with the query path). */
    readonly collectFiles?: (cwd: string, paths: readonly string[]) => Promise<readonly string[]>;
};

type AstGrepQueryOnlyOptions = {
    readonly registry?: undefined;
    readonly requestPermission?: undefined;
};

type AstGrepRewriteOptions = {
    readonly registry: StagedPreviewRegistry;
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
};

export type AstGrepToolOptions = AstGrepToolBaseOptions & (AstGrepQueryOnlyOptions | AstGrepRewriteOptions);

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
