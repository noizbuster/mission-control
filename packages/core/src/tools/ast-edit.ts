// allow: SIZE_OK — single cohesive concept (ast structural rewrite propose/apply).
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
import {
    createNativesClient,
    type NativeAstReplaceChange,
    type NativeAstRewriteOptions,
    type NativesClient,
} from '../native/natives-client.js';
import { defaultAstSearchFileCollector } from './ast-grep-runner.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { relative } from 'node:path';

export {
    type AstEditInput,
    type AstEditOutput,
    type AstEditReplacement,
    astEditInputSchema,
    astEditOutputSchema,
    astEditParametersJsonSchema,
} from './ast-edit-schemas.js';

import {
    type AstEditInput,
    type AstEditOutput,
    type AstEditReplacement,
    astEditInputSchema,
    astEditOutputSchema,
    astEditParametersJsonSchema,
} from './ast-edit-schemas.js';
import { filePatchFailure } from './file-patch-errors.js';
import { isDirtyTrackedTarget } from './file-patch-git.js';
import { createPatchWorkspaceGuard, type PatchTarget } from './file-patch-paths.js';
import {
    type StagedPreviewAction,
    type StagedPreviewChange,
    type StagedPreviewRegistry,
} from './staged-preview-registry.js';
import { permissionRequest, requestToolPermission } from './tool-permissions.js';
import { type ToolAdvertisement, ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry.js';

const AST_EDIT_TOOL_NAME = 'ast_edit';
const STALE_PREVIEW_MESSAGE =
    'Preview is stale: the file changed between propose and apply. Re-run ast_edit to refresh the preview.';

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
    /**
     * Optional write-approval callback invoked at apply time (after staleness
     * re-validation, before a write). Mirrors `file.edit`'s approval gate.
     */
    readonly requestPermission?: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
    /** Injectable file collector (defaults to the workspace-vetted walker). */
    readonly collectFiles?: (cwd: string, paths: readonly string[]) => Promise<readonly string[]>;
};

/**
 * Dry-run structural rewrite. Receives caller-vetted absolute file paths,
 * returns computed changes (with byte ranges) WITHOUT writing. Throws when the
 * underlying ast module is unavailable so the tool surfaces a clean failure.
 */
export type AstRewriteFn = (
    pattern: string,
    files: readonly string[],
    opts: { readonly replacement: string; readonly lang?: string },
) => readonly NativeAstReplaceChange[];

/**
 * Build the default rewriter over a `NativesClient`. Returns a closure that
 * delegates to `astRewrite` and throws when the addon is unavailable or the
 * build predates the ast module (so `ast_edit` reports a clean tool failure
 * rather than silently proposing nothing).
 */
export function createDefaultAstRewriter(natives: NativesClient): AstRewriteFn {
    return (pattern, files, opts) => {
        const nativeOpts: NativeAstRewriteOptions = {
            replacement: opts.replacement,
            ...(opts.lang !== undefined ? { lang: opts.lang } : {}),
        };
        const result = natives.astRewrite(pattern, [...files], nativeOpts);
        if (result === null) {
            throw new Error('ast module unavailable: the native addon is missing or predates the ast-rewrite module');
        }
        return result;
    };
}

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
        toModelOutput: astEditModelOutput,
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
        return noMatchResult();
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
        return noMatchResult();
    }

    const replacements = summarizeReplacements(changes, options.workspaceRoot);
    const proposedCount = changes.length;

    // Stage the apply closure: it re-runs the rewriter on `resolve` (re-validation),
    // checks staleness, then splices byte ranges and writes. ast_edit itself
    // writes nothing.
    const apply = (reason: string): Promise<readonly StagedPreviewChange[]> =>
        applyStagedAstEdit({
            reason,
            pattern: input.pattern,
            replacement: input.replacement,
            ...(input.language !== undefined ? { language: input.language } : {}),
            files,
            workspaceRoot: options.workspaceRoot,
            guard,
            rewriter,
            proposedCount,
            proposedReplacements: replacements,
            ...(options.requestPermission !== undefined ? { requestPermission: options.requestPermission } : {}),
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

export async function applyStagedAstEdit(args: {
    readonly reason: string;
    readonly pattern: string;
    readonly replacement: string;
    readonly language?: string;
    readonly files: readonly string[];
    readonly workspaceRoot: string;
    readonly guard: Awaited<ReturnType<typeof createPatchWorkspaceGuard>>;
    readonly rewriter: AstRewriteFn;
    readonly proposedCount: number;
    readonly proposedReplacements: readonly AstEditReplacement[];
    readonly requestPermission?: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
}): Promise<readonly StagedPreviewChange[]> {
    // 1) Re-run the dry-run rewrite against CURRENT disk content. The fresh
    //    changes' byte ranges are valid against the freshly-read file.
    let fresh: readonly NativeAstReplaceChange[];
    try {
        fresh = args.rewriter(args.pattern, args.files, {
            replacement: args.replacement,
            ...(args.language !== undefined ? { lang: args.language } : {}),
        });
    } catch (error: unknown) {
        throw filePatchFailure('patch_apply_failed', `ast_edit apply failed: ${errorMessage(error)}`);
    }

    // 2) Staleness re-validation: total + per-file counts must match the preview.
    assertPreviewNotStale(fresh, args.proposedCount, args.proposedReplacements, args.workspaceRoot);

    // 3) Resolve + vet every target (containment, symlink escape, dirty tracked
    //    file) BEFORE writing, so a vetting failure leaves disk untouched.
    const byFile = groupChangesByFile(fresh);
    const planned: Array<{ readonly target: PatchTarget; readonly changes: readonly NativeAstReplaceChange[] }> = [];
    for (const [absolutePath, fileChanges] of byFile) {
        const target = await args.guard.resolveTarget(absolutePath, 'existing');
        if (await isDirtyIfTracked(args.workspaceRoot, target.relativePath)) {
            throw filePatchFailure('dirty_target', `dirty tracked target refused: ${target.relativePath}`);
        }
        planned.push({ target, changes: fileChanges });
    }

    // 4) Optional write-approval gate (mirrors file.edit's approval broker).
    if (args.requestPermission !== undefined) {
        const request = permissionRequest({
            toolCallId: `${AST_EDIT_TOOL_NAME}.apply`,
            action: 'ast_edit apply',
            reason: args.reason,
            permission: 'edit',
            patterns: planned.map((entry) => entry.target.relativePath),
            workspaceRoot: args.workspaceRoot,
        });
        const decision = await requestToolPermission(args.requestPermission, request);
        if (decision.status !== 'allow') {
            throw filePatchFailure(
                'approval_denied',
                decision.reason ?? `ast_edit apply not approved: ${decision.status}`,
            );
        }
    }

    // 5) Read + splice every file into memory BEFORE writing (atomicity: a
    //    splice failure leaves disk untouched).
    const spliced: Array<{ readonly target: PatchTarget; readonly content: Buffer }> = [];
    for (const entry of planned) {
        const original = await readTargetBuffer(entry.target);
        const next = applyByteRangeChanges(original, entry.changes);
        spliced.push({ target: entry.target, content: next });
    }

    // 6) Commit every file. This is the only write window.
    for (const entry of spliced) {
        await writeTargetBuffer(entry.target, entry.content);
    }

    return spliced.map((entry) => ({
        path: entry.target.relativePath,
        count: planned.find((p) => p.target.relativePath === entry.target.relativePath)?.changes.length ?? 0,
    }));
}

function assertPreviewNotStale(
    fresh: readonly NativeAstReplaceChange[],
    proposedCount: number,
    proposedReplacements: readonly AstEditReplacement[],
    workspaceRoot: string,
): void {
    if (fresh.length !== proposedCount) {
        throw filePatchFailure('patch_apply_failed', STALE_PREVIEW_MESSAGE);
    }
    const freshByFile = new Map<string, number>();
    for (const change of fresh) {
        const rel = toRelative(workspaceRoot, change.path);
        freshByFile.set(rel, (freshByFile.get(rel) ?? 0) + 1);
    }
    for (const proposed of proposedReplacements) {
        if ((freshByFile.get(proposed.path) ?? 0) !== proposed.count) {
            throw filePatchFailure('patch_apply_failed', STALE_PREVIEW_MESSAGE);
        }
    }
    for (const [rel] of freshByFile) {
        if (!proposedReplacements.some((entry) => entry.path === rel)) {
            throw filePatchFailure('patch_apply_failed', STALE_PREVIEW_MESSAGE);
        }
    }
}

/** Apply non-overlapping byte-range replacements to a buffer. Sorts descending
 * by start offset so earlier splices never shift later offsets. Rejects overlaps. */
function applyByteRangeChanges(content: Buffer, changes: readonly NativeAstReplaceChange[]): Buffer {
    if (changes.length === 0) {
        return content;
    }
    const ascending = [...changes].sort((left, right) => left.byteStart - right.byteStart);
    let previousEnd = -1;
    for (const change of ascending) {
        if (change.byteStart < previousEnd) {
            throw filePatchFailure('patch_apply_failed', `overlapping ast replacements near byte ${change.byteStart}`);
        }
        previousEnd = change.byteEnd;
    }
    let out = content;
    for (const change of [...ascending].reverse()) {
        const after = Buffer.from(change.after, 'utf8');
        out = Buffer.concat([out.subarray(0, change.byteStart), after, out.subarray(change.byteEnd)]);
    }
    return out;
}

function groupChangesByFile(
    changes: readonly NativeAstReplaceChange[],
): ReadonlyMap<string, readonly NativeAstReplaceChange[]> {
    const map = new Map<string, NativeAstReplaceChange[]>();
    for (const change of changes) {
        const bucket = map.get(change.path);
        if (bucket === undefined) {
            map.set(change.path, [change]);
        } else {
            bucket.push(change);
        }
    }
    return map;
}

function summarizeReplacements(
    changes: readonly NativeAstReplaceChange[],
    workspaceRoot: string,
): readonly AstEditReplacement[] {
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

/**
 * Dirty-tracked check that tolerates a non-git workspace. The semantic of the
 * check is "refuse to overwrite a file with uncommitted git changes"; in a
 * directory with no git, nothing is tracked, so the check is vacuously
 * satisfied. `isDirtyTrackedTarget` throws `git_status_failed` outside git —
 * we swallow that one case (rethrowing genuine git errors) so `ast_edit` works
 * in both git and non-git workspaces.
 */
async function isDirtyIfTracked(workspaceRoot: string, relativePath: string): Promise<boolean> {
    try {
        return await isDirtyTrackedTarget(workspaceRoot, relativePath);
    } catch (error: unknown) {
        if (error instanceof ToolExecutionError && error.error.message.includes('not a git repository')) {
            return false;
        }
        throw error;
    }
}

async function readTargetBuffer(target: PatchTarget): Promise<Buffer> {
    const handle = await open(target.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        return await handle.readFile();
    } finally {
        await handle.close();
    }
}

async function writeTargetBuffer(target: PatchTarget, content: Buffer): Promise<void> {
    const handle = await open(target.absolutePath, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    try {
        await handle.writeFile(content);
    } finally {
        await handle.close();
    }
}

function noMatchResult(): AstEditOutput {
    return {
        proposed: 0,
        files: 0,
        replacements: [],
        staged: false,
        message: 'ast_edit: no replacements proposed. Nothing staged for resolve.',
    };
}

function astEditModelOutput(output: AstEditOutput): string {
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

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
