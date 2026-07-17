import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import type { NativeAstReplaceChange } from '../native/natives-client';
import { AST_EDIT_TOOL_NAME } from './ast-edit-identity';
import type { AstRewriteFn } from './ast-edit-rewriter';
import type { AstEditReplacement } from './ast-edit-schemas';
import { executeFileMutation } from './file-mutation';
import { filePatchFailure } from './file-patch-errors';
import { isDirtyTrackedTarget } from './file-patch-git';
import { createPatchWorkspaceGuard, type PatchTarget } from './file-patch-paths';
import type { StagedPreviewChange } from './staged-preview-registry';
import { ToolExecutionError } from './tool-registry';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { relative } from 'node:path';

const STALE_PREVIEW_MESSAGE =
    'Preview is stale: the file changed between propose and apply. Re-run ast_edit to refresh the preview.';

export async function applyStagedAstEdit(args: {
    readonly reason: string;
    readonly resolveToolCallId: string;
    readonly pattern: string;
    readonly replacement: string;
    readonly language?: string;
    readonly files: readonly string[];
    readonly workspaceRoot: string;
    readonly guard: Awaited<ReturnType<typeof createPatchWorkspaceGuard>>;
    readonly rewriter: AstRewriteFn;
    readonly proposedCount: number;
    readonly proposedReplacements: readonly AstEditReplacement[];
    readonly proposedChanges: readonly NativeAstReplaceChange[];
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
}): Promise<readonly StagedPreviewChange[]> {
    return executeFileMutation({
        queueKey: args.guard.root,
        approval: {
            workspaceRoot: args.guard.root,
            toolCallId: args.resolveToolCallId,
            action: `${AST_EDIT_TOOL_NAME} apply`,
            reason: args.reason,
            permission: 'edit',
            patterns: args.proposedReplacements.map((entry) => entry.path),
            requestPermission: args.requestPermission,
        },
        preflight: () => preflightAstMutation(args),
        apply: applyPlannedAstChanges,
    });
}

type PlannedAstMutation = PatchTarget & {
    readonly changes: readonly NativeAstReplaceChange[];
};

async function preflightAstMutation(
    args: Parameters<typeof applyStagedAstEdit>[0],
): Promise<readonly PlannedAstMutation[]> {
    let fresh: readonly NativeAstReplaceChange[];
    try {
        fresh = args.rewriter(args.pattern, args.files, {
            replacement: args.replacement,
            ...(args.language !== undefined ? { lang: args.language } : {}),
        });
    } catch (error: unknown) {
        const message = error instanceof Error ? error.message : String(error);
        throw filePatchFailure('patch_apply_failed', `ast_edit apply failed: ${message}`);
    }

    assertPreviewNotStale(
        fresh,
        args.proposedCount,
        args.proposedReplacements,
        args.proposedChanges,
        args.workspaceRoot,
    );

    const byFile = groupChangesByFile(fresh);
    const planned: PlannedAstMutation[] = [];
    for (const [absolutePath, fileChanges] of byFile) {
        const target = await args.guard.resolveTarget(absolutePath, 'existing');
        if (await isDirtyIfTracked(args.workspaceRoot, target.relativePath)) {
            throw filePatchFailure('dirty_target', `dirty tracked target refused: ${target.relativePath}`);
        }
        assertChangesMatchContent(await readTargetBuffer(target), fileChanges);
        planned.push({ ...target, changes: fileChanges });
    }
    return planned;
}

async function applyPlannedAstChanges(planned: readonly PlannedAstMutation[]): Promise<readonly StagedPreviewChange[]> {
    const spliced: Array<{ readonly target: PlannedAstMutation; readonly content: Buffer }> = [];
    for (const entry of planned) {
        const original = await readTargetBuffer(entry);
        assertChangesMatchContent(original, entry.changes);
        const next = applyByteRangeChanges(original, entry.changes);
        spliced.push({ target: entry, content: next });
    }

    for (const entry of spliced) {
        await writeTargetBuffer(entry.target, entry.content);
    }

    return spliced.map((entry) => ({
        path: entry.target.relativePath,
        count: entry.target.changes.length,
    }));
}

function assertPreviewNotStale(
    fresh: readonly NativeAstReplaceChange[],
    proposedCount: number,
    proposedReplacements: readonly AstEditReplacement[],
    proposedChanges: readonly NativeAstReplaceChange[],
    workspaceRoot: string,
): void {
    if (fresh.length !== proposedCount) {
        throw filePatchFailure('patch_apply_failed', STALE_PREVIEW_MESSAGE);
    }
    const freshByFile = new Map<string, number>();
    for (const change of fresh) {
        const relativePath = toRelative(workspaceRoot, change.path);
        freshByFile.set(relativePath, (freshByFile.get(relativePath) ?? 0) + 1);
    }
    for (const proposed of proposedReplacements) {
        if ((freshByFile.get(proposed.path) ?? 0) !== proposed.count) {
            throw filePatchFailure('patch_apply_failed', STALE_PREVIEW_MESSAGE);
        }
    }
    for (const [relativePath] of freshByFile) {
        if (!proposedReplacements.some((entry) => entry.path === relativePath)) {
            throw filePatchFailure('patch_apply_failed', STALE_PREVIEW_MESSAGE);
        }
    }
    if (fresh.length !== proposedChanges.length) {
        throw filePatchFailure('patch_apply_failed', STALE_PREVIEW_MESSAGE);
    }
    for (const [index, freshChange] of fresh.entries()) {
        const proposedChange = proposedChanges[index];
        if (proposedChange === undefined || !sameAstChange(freshChange, proposedChange)) {
            throw filePatchFailure('patch_apply_failed', STALE_PREVIEW_MESSAGE);
        }
    }
}

function sameAstChange(left: NativeAstReplaceChange, right: NativeAstReplaceChange): boolean {
    return (
        left.path === right.path &&
        left.before === right.before &&
        left.after === right.after &&
        left.byteStart === right.byteStart &&
        left.byteEnd === right.byteEnd &&
        left.startLine === right.startLine &&
        left.startColumn === right.startColumn &&
        left.endLine === right.endLine &&
        left.endColumn === right.endColumn
    );
}

function assertChangesMatchContent(content: Buffer, changes: readonly NativeAstReplaceChange[]): void {
    for (const change of changes) {
        const expected = Buffer.from(change.before, 'utf8');
        const actual = content.subarray(change.byteStart, change.byteEnd);
        if (change.byteStart < 0 || change.byteEnd > content.byteLength || !actual.equals(expected)) {
            throw filePatchFailure('patch_apply_failed', STALE_PREVIEW_MESSAGE);
        }
    }
}

function applyByteRangeChanges(content: Buffer, changes: readonly NativeAstReplaceChange[]): Buffer {
    if (changes.length === 0) return content;
    const ascending = [...changes].sort((left, right) => left.byteStart - right.byteStart);
    let previousEnd = -1;
    for (const change of ascending) {
        if (change.byteStart < previousEnd) {
            throw filePatchFailure('patch_apply_failed', `overlapping ast replacements near byte ${change.byteStart}`);
        }
        previousEnd = change.byteEnd;
    }
    let output = content;
    for (const change of [...ascending].reverse()) {
        const after = Buffer.from(change.after, 'utf8');
        output = Buffer.concat([output.subarray(0, change.byteStart), after, output.subarray(change.byteEnd)]);
    }
    return output;
}

function groupChangesByFile(
    changes: readonly NativeAstReplaceChange[],
): ReadonlyMap<string, readonly NativeAstReplaceChange[]> {
    const grouped = new Map<string, NativeAstReplaceChange[]>();
    for (const change of changes) {
        const existing = grouped.get(change.path);
        if (existing === undefined) grouped.set(change.path, [change]);
        else existing.push(change);
    }
    return grouped;
}

async function isDirtyIfTracked(workspaceRoot: string, relativePath: string): Promise<boolean> {
    try {
        return await isDirtyTrackedTarget(workspaceRoot, relativePath);
    } catch (error: unknown) {
        if (error instanceof ToolExecutionError && error.error.message.includes('not a git repository')) return false;
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

function toRelative(workspaceRoot: string, absolutePath: string): string {
    const relativePath = relative(workspaceRoot, absolutePath);
    return relativePath.length === 0 ? absolutePath : relativePath;
}
