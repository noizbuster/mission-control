/**
 * `ast_edit` tool (Wave 4, task 12).
 *
 * Proposes N structural replacements via the N-API ast module (`astRewrite`,
 * task 8) WITHOUT writing, then stages the apply through the session-scoped
 * {@link StagedPreviewRegistry}. `resolve` is the ONLY commit path. Algorithm
 * adapted from oh-my-pi's `AstEditTool` (MIT, Can Bölük / Mario Zechner) with
 * attribution: dry-run compute, stage, re-validate on apply, splice byte
 * ranges, write.
 *
 * Flow:
 * 1. `ast_edit` collects caller-vetted absolute files (re-uses task 11's
 *    `defaultAstSearchFileCollector`) and calls `astRewrite` to compute the
 *    replacement set (the N-API method is dry-run only; it never writes).
 * 2. The replacement set is summarised and the apply closure is registered on
 *    the shared {@link StagedPreviewRegistry}. `ast_edit` returns
 *    `(proposed) N replacements` and writes nothing.
 * 3. On `resolve(action:'apply')`, the staged closure re-runs `astRewrite`
 *    against current disk (re-validation), rejects a stale preview when the
 *    counts diverge, then splices each file's byte ranges and writes.
 *
 * Why `astRewrite` (not `astGrep`): the dry-run `astRewrite` returns computed
 * `before`/`after`/byte-range changes in one pass; `astGrep` returns matches
 * only and cannot produce replacement text. Using `astRewrite` for both the
 * preview and the apply re-validation mirrors oh-my-pi's `dryRun:true` /
 * `dryRun:false` re-run pattern with a single primitive.
 */
import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import type { z } from 'zod';
import { createNativesClient, type NativeAstReplaceChange } from '../native/natives-client';
import { defaultAstSearchFileCollector } from './ast-grep-runner';

export {
    type AstEditInput,
    type AstEditOutput,
    type AstEditReplacement,
    astEditInputSchema,
    astEditOutputSchema,
    astEditParametersJsonSchema,
} from './ast-edit-schemas';

import { applyStagedAstEdit } from './ast-edit-apply';
import { AST_EDIT_TOOL_NAME } from './ast-edit-identity';
import { formatAstEditModelOutput, noAstEditMatchResult, summarizeAstEditReplacements } from './ast-edit-preview';
import { type AstRewriteFn, createDefaultAstRewriter } from './ast-edit-rewriter';
import {
    type AstEditInput,
    type AstEditOutput,
    astEditInputSchema,
    astEditOutputSchema,
    astEditParametersJsonSchema,
} from './ast-edit-schemas';
import { createPatchWorkspaceGuard } from './file-patch-paths';
import {
    type StagedPreviewAction,
    type StagedPreviewChange,
    type StagedPreviewRegistry,
} from './staged-preview-registry';
import { type ToolAdvertisement, ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry';

export { applyStagedAstEdit } from './ast-edit-apply';
export { type AstRewriteFn, createDefaultAstRewriter } from './ast-edit-rewriter';

export type AstEditToolOptions = {
    readonly workspaceRoot: string;
    /** Shared with `resolve`: where the staged preview is held. */
    readonly registry: StagedPreviewRegistry;
    /**
     * Dry-run rewriter. Defaults to {@link createDefaultAstRewriter} over a
     * `NativesClient`; injectable so tests exercise propose/apply without the
     * native addon. Throws when the ast module is unavailable.
     */
    readonly rewriter?: AstRewriteFn;
    /** Write-approval callback invoked at apply time (after staleness
     * re-validation, before a write). Mirrors `file.edit`'s approval gate. */
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    /** Injectable file collector (defaults to the workspace-vetted walker). */
    readonly collectFiles?: (cwd: string, paths: readonly string[]) => Promise<readonly string[]>;
};

export async function registerAstEditTool(
    registry: ToolRegistry,
    options: AstEditToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(await createAstEditToolRegistration(options));
}

export async function createAstEditToolRegistration(
    options: AstEditToolOptions,
): Promise<ToolRegistration<AstEditInput, AstEditOutput>> {
    const guard = await createPatchWorkspaceGuard(options.workspaceRoot);
    const rewriter: AstRewriteFn = options.rewriter ?? createDefaultAstRewriter(createNativesClient());
    const collectFiles = options.collectFiles ?? defaultAstSearchFileCollector;
    return {
        name: AST_EDIT_TOOL_NAME,
        description:
            'Propose structural code rewrites via ast-grep (50+ languages). Returns a (proposed) N replacements ' +
            'preview WITHOUT writing. Call resolve(action:"apply") to commit, or resolve(action:"discard") to drop.',
        capabilityClasses: ['file.edit'],
        parametersJsonSchema: astEditParametersJsonSchema(),
        // exactOptionalPropertyTypes: hand-written types omit `| undefined` on optional fields; Zod infers it.
        inputSchema: astEditInputSchema as z.ZodType<AstEditInput>,
        outputSchema: astEditOutputSchema as z.ZodType<AstEditOutput>,
        outputLimit: { maxModelOutputChars: 8000 },
        execute: (input) => executeAstEdit(input, options, guard, rewriter, collectFiles),
        toModelOutput: formatAstEditModelOutput,
        guideline:
            'Use ast_edit for structural refactors (rename calls, modernize syntax, swap imports). ' +
            'It only PROPOSES — always follow with resolve to apply or discard. resolve is the only commit path.',
    };
}

async function executeAstEdit(
    input: AstEditInput,
    options: AstEditToolOptions,
    guard: Awaited<ReturnType<typeof createPatchWorkspaceGuard>>,
    rewriter: AstRewriteFn,
    collectFiles: (cwd: string, paths: readonly string[]) => Promise<readonly string[]>,
): Promise<AstEditOutput> {
    const files = await collectFiles(options.workspaceRoot, input.paths);
    if (files.length === 0) {
        return noAstEditMatchResult();
    }
    let changes: readonly NativeAstReplaceChange[];
    try {
        changes = rewriter(input.pattern, files, {
            replacement: input.replacement,
            ...(input.language !== undefined ? { lang: input.language } : {}),
        });
    } catch (error: unknown) {
        throw new ToolExecutionError({
            code: 'tool_failed',
            message: `ast_edit failed: ${errorMessage(error)}`,
            retryable: true,
        });
    }
    if (changes.length === 0) {
        return noAstEditMatchResult();
    }

    const replacements = summarizeAstEditReplacements(changes, options.workspaceRoot);
    const proposedCount = changes.length;

    // Stage the apply closure: it re-runs the rewriter on `resolve` (re-validation),
    // checks staleness, then splices byte ranges and writes. ast_edit itself
    // writes nothing.
    const apply = (reason: string, resolveToolCallId: string): Promise<readonly StagedPreviewChange[]> =>
        applyStagedAstEdit({
            reason,
            resolveToolCallId,
            pattern: input.pattern,
            replacement: input.replacement,
            ...(input.language !== undefined ? { language: input.language } : {}),
            files,
            workspaceRoot: options.workspaceRoot,
            guard,
            rewriter,
            proposedCount,
            proposedReplacements: replacements,
            proposedChanges: changes,
            requestPermission: options.requestPermission,
        });

    const action: StagedPreviewAction = {
        id: `${AST_EDIT_TOOL_NAME}:${proposedCount}`,
        summary: {
            label: `AST Edit: ${proposedCount} replacement${proposedCount === 1 ? '' : 's'} in ${replacements.length} file${replacements.length === 1 ? '' : 's'}`,
            sourceToolName: AST_EDIT_TOOL_NAME,
            proposedCount,
            files: replacements,
        },
        apply,
    };
    options.registry.register(action);

    const plural = proposedCount === 1 ? '' : 's';
    const filePlural = replacements.length === 1 ? '' : 's';
    return {
        proposed: proposedCount,
        files: replacements.length,
        replacements,
        staged: true,
        message:
            `(proposed) ${proposedCount} replacement${plural} in ${replacements.length} file${filePlural}. ` +
            'Call resolve(action:"apply", reason:"...") to commit, or resolve(action:"discard", reason:"...") to drop.',
    };
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
