import { createNativesClient } from '../native/natives-client';
import { applyStagedAstEdit } from './ast-edit-apply';
import { type AstRewriteFn, createDefaultAstRewriter } from './ast-edit-rewriter';
import { AST_GREP_TOOL_NAME } from './ast-grep-identity';
import { defaultAstSearchFileCollector } from './ast-grep-runner';
import type { AstGrepInput, AstGrepReplacement, AstGrepRewriteOutput } from './ast-grep-schemas';
import type { AstGrepToolOptions } from './ast-grep-tool';
import { createPatchWorkspaceGuard } from './file-patch-paths';
import type { StagedPreviewAction, StagedPreviewChange } from './staged-preview-registry';
import { ToolExecutionError } from './tool-registry';
import { relative } from 'node:path';

export async function executeAstGrepRewrite(
    input: AstGrepInput,
    options: AstGrepToolOptions,
): Promise<AstGrepRewriteOutput> {
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
    if (files.length === 0) return noReplacementResult();

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
    if (changes.length === 0) return noReplacementResult();

    const replacements = summarizeReplacements(changes, options.workspaceRoot);
    const proposedCount = changes.length;
    const apply = (reason: string, resolveToolCallId: string): Promise<readonly StagedPreviewChange[]> =>
        applyStagedAstEdit({
            reason,
            resolveToolCallId,
            pattern: input.pattern,
            replacement,
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

function summarizeReplacements(
    changes: readonly { readonly path: string }[],
    workspaceRoot: string,
): readonly AstGrepReplacement[] {
    const counts = new Map<string, number>();
    const order: string[] = [];
    for (const change of changes) {
        const relativePath = toRelative(workspaceRoot, change.path);
        if (!counts.has(relativePath)) {
            order.push(relativePath);
            counts.set(relativePath, 0);
        }
        counts.set(relativePath, (counts.get(relativePath) ?? 0) + 1);
    }
    return order.map((path) => ({ path, count: counts.get(path) ?? 0 }));
}

function toRelative(workspaceRoot: string, absolutePath: string): string {
    const relativePath = relative(workspaceRoot, absolutePath);
    return relativePath.length === 0 ? absolutePath : relativePath;
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
