import type { DiffFile, DiffLine, ProtocolError } from '@mission-control/protocol';
import { executeFileMutation, fileMutationDiffEvents, preflightTextFileMutationTargets } from './file-mutation.js';
import { filePatchFailure } from './file-patch-errors.js';
import { createPatchWorkspaceGuard, type PatchTarget } from './file-patch-paths.js';
import {
    executeHashlineEdits,
    type HashlineEditOutcome,
    type RawHashlineEdit,
} from './hashline/hashline-edit-executor.js';
import { HashlineMismatchError } from './hashline/validation.js';
import {
    type HashlineEditInput,
    type HashlineEditOutput,
    type HashlineEditToolOptions,
    hashlineEditDiffOutput,
    hashlineEditInputSchema,
    hashlineEditModelOutput,
    hashlineEditOutputSchema,
    hashlineEditParametersJsonSchema,
    type ResolvedHashlineEditToolOptions,
    resolveHashlineEditOptions,
} from './hashline-edit-schemas.js';
import { type ToolAdvertisement, ToolExecutionError, type ToolRegistration, ToolRegistry } from './tool-registry.js';
import { constants } from 'node:fs';
import { open, rm } from 'node:fs/promises';

export type { HashlineEditToolOptions } from './hashline-edit-schemas.js';

export async function registerHashlineEditTool(
    registry: ToolRegistry,
    options: HashlineEditToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(await createHashlineEditToolRegistration(options));
}

export async function createHashlineEditToolRegistration(
    options: HashlineEditToolOptions,
): Promise<ToolRegistration<HashlineEditInput, HashlineEditOutput>> {
    const resolved = resolveHashlineEditOptions(options);
    const guard = await createPatchWorkspaceGuard(resolved.workspaceRoot);
    return {
        name: 'hashline_edit',
        description:
            'Edit a workspace file by LINE#ID content-hash anchors. Get anchors from repo.read.tagged, then replace/append/prepend lines by their NN#XX tag. Rejects on stale content (hash mismatch) before writing.',
        capabilityClasses: ['file.edit'],
        parametersJsonSchema: hashlineEditParametersJsonSchema(),
        inputSchema: hashlineEditInputSchema,
        outputSchema: hashlineEditOutputSchema,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => applyHashlineEditTool(resolved, guard, input, context.toolCallId),
        toModelOutput: hashlineEditModelOutput,
        toEvents: hashlineEditDiffEvents,
    };
}

async function applyHashlineEditTool(
    options: ResolvedHashlineEditToolOptions,
    guard: Awaited<ReturnType<typeof createPatchWorkspaceGuard>>,
    input: HashlineEditInput,
    toolCallId: string,
): Promise<HashlineEditOutput> {
    if (input.delete === true) {
        return deleteFileViaMutation(options, guard, input, toolCallId);
    }
    return executeFileMutation({
        queueKey: guard.root,
        approval: {
            workspaceRoot: options.workspaceRoot,
            toolCallId,
            action: 'hashline_edit',
            reason: `hashline edit in ${input.path}`,
            permission: 'edit',
            patterns: [input.path],
            requestPermission: options.requestPermission,
        },
        preflight: () =>
            preflightTextFileMutationTargets({
                workspaceRoot: options.workspaceRoot,
                guard,
                targets: [
                    {
                        path: input.path,
                        mode: 'either',
                        ...(canCreateFromMissingFile(input.edits) ? { createParentDirectories: true } : {}),
                    },
                ],
                allowDirtyPaths: options.allowDirtyPaths,
            }),
        apply: async (targets) => applyHashlineEditsToTarget(input, requireSingleTarget(targets)),
    });
}

function canCreateFromMissingFile(edits: readonly HashlineEditInput['edits'][number][]): boolean {
    if (edits.length === 0) {
        return false;
    }
    return edits.every((edit) => (edit.op === 'append' || edit.op === 'prepend') && edit.pos === undefined);
}

async function applyHashlineEditsToTarget(input: HashlineEditInput, target: PatchTarget): Promise<HashlineEditOutput> {
    const beforeContent = target.exists ? await readExistingFile(target) : '';
    let outcome: HashlineEditOutcome;
    try {
        outcome = executeHashlineEdits(beforeContent, input.edits as readonly RawHashlineEdit[]);
    } catch (error: unknown) {
        if (error instanceof HashlineMismatchError) {
            // Stale anchor: the file changed between the tagged read and this
            // edit. Surface as a retryable failure so the model re-reads and
            // retries with the corrected anchors the message carries.
            const protocolError: ProtocolError = {
                code: 'tool_failed',
                message: `hash mismatch - ${error.message}`,
                retryable: true,
            };
            throw new ToolExecutionError(protocolError, []);
        }
        throw error;
    }
    if (outcome.unchanged) {
        throw filePatchFailure(
            'edit_not_found',
            `hashline_edit produced no changes to ${target.relativePath}; the edits matched the current content. Re-read with repo.read.tagged and adjust the replacement lines.`,
        );
    }
    await writeEditedFile(target, outcome.afterContent);
    return {
        kind: 'hashline_edit',
        status: 'applied',
        appliedFiles: [target.relativePath],
        appliedEdits: outcome.appliedEdits,
        noopEdits: outcome.noopEdits,
        deduplicatedEdits: outcome.deduplicatedEdits,
        diffFiles: [buildDiffFile(target.relativePath, beforeContent, outcome.afterContent, outcome.firstChangedLine)],
    };
}

async function deleteFileViaMutation(
    options: ResolvedHashlineEditToolOptions,
    guard: Awaited<ReturnType<typeof createPatchWorkspaceGuard>>,
    input: HashlineEditInput,
    toolCallId: string,
): Promise<HashlineEditOutput> {
    return executeFileMutation({
        queueKey: guard.root,
        approval: {
            workspaceRoot: options.workspaceRoot,
            toolCallId,
            action: 'hashline_edit',
            reason: `delete ${input.path}`,
            permission: 'edit',
            patterns: [input.path],
            requestPermission: options.requestPermission,
        },
        preflight: () =>
            preflightTextFileMutationTargets({
                workspaceRoot: options.workspaceRoot,
                guard,
                targets: [{ path: input.path, mode: 'existing' }],
                allowDirtyPaths: options.allowDirtyPaths,
            }),
        apply: async (targets) => {
            const target = requireSingleTarget(targets);
            const beforeContent = await readExistingFile(target);
            await rm(target.absolutePath, { force: false });
            return {
                kind: 'hashline_edit' as const,
                status: 'deleted' as const,
                appliedFiles: [target.relativePath],
                appliedEdits: 0,
                noopEdits: 0,
                deduplicatedEdits: 0,
                diffFiles: [buildDeletionDiffFile(target.relativePath, beforeContent)],
            };
        },
    });
}

function requireSingleTarget(targets: readonly PatchTarget[]): PatchTarget {
    const target = targets[0];
    if (target === undefined) {
        throw filePatchFailure('write_failed', 'missing hashline_edit target');
    }
    return target;
}

async function readExistingFile(target: PatchTarget): Promise<string> {
    const handle = await open(target.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        return await handle.readFile('utf8');
    } finally {
        await handle.close();
    }
}

async function writeEditedFile(target: PatchTarget, content: string): Promise<void> {
    const handle = await open(
        target.absolutePath,
        constants.O_WRONLY | constants.O_TRUNC | constants.O_CREAT | constants.O_NOFOLLOW,
    );
    try {
        await handle.writeFile(content, 'utf8');
    } finally {
        await handle.close();
    }
}

function buildDiffFile(
    relativePath: string,
    before: string,
    after: string,
    firstChangedLine: number | undefined,
): DiffFile {
    const beforeLines = before.length === 0 ? [] : before.split('\n');
    const afterLines = after.length === 0 ? [] : after.split('\n');
    if (firstChangedLine === undefined) {
        return {
            filePath: relativePath,
            changeKind: 'modified',
            hunks: [
                {
                    oldStart: 1,
                    oldLines: beforeLines.length,
                    newStart: 1,
                    newLines: afterLines.length,
                    lines: [...toDiffLines('removed', beforeLines), ...toDiffLines('added', afterLines)],
                },
            ],
        };
    }
    const lastChanged = lastDifferingLine(beforeLines, afterLines);
    const start = Math.max(1, firstChangedLine);
    const end = lastChanged;
    const oldSpan = beforeLines.slice(start - 1, end);
    const newSpan = afterLines.slice(start - 1, end);
    return {
        filePath: relativePath,
        changeKind: 'modified',
        hunks: [
            {
                oldStart: start,
                oldLines: Math.max(oldSpan.length, 1),
                newStart: start,
                newLines: Math.max(newSpan.length, 1),
                lines: [...toDiffLines('removed', oldSpan), ...toDiffLines('added', newSpan)],
            },
        ],
    };
}

function buildDeletionDiffFile(relativePath: string, before: string): DiffFile {
    const beforeLines = before.length === 0 ? [] : before.split('\n');
    return {
        filePath: relativePath,
        changeKind: 'deleted',
        hunks: [
            {
                oldStart: 1,
                oldLines: Math.max(beforeLines.length, 1),
                newStart: 1,
                newLines: 0,
                lines: toDiffLines('removed', beforeLines),
            },
        ],
    };
}

function lastDifferingLine(before: readonly string[], after: readonly string[]): number {
    const max = Math.max(before.length, after.length);
    let last = max;
    for (let index = max - 1; index >= 0; index -= 1) {
        if ((before[index] ?? '') !== (after[index] ?? '')) {
            last = index + 1;
            break;
        }
        last = index;
    }
    return Math.max(1, last);
}

function toDiffLines(kind: DiffLine['kind'], lines: readonly string[]): DiffLine[] {
    return lines.map((content) => ({ kind, content }));
}

function hashlineEditDiffEvents(output: HashlineEditOutput, context: { readonly toolCallId: string }) {
    if (output.status === 'deleted') {
        return fileMutationDiffEvents(output.diffFiles, context.toolCallId, {
            proposed: 'hashline delete proposed',
            applied: 'hashline delete applied',
        });
    }
    return fileMutationDiffEvents(output.diffFiles, context.toolCallId, {
        proposed: 'hashline edit proposed',
        applied: 'hashline edit applied',
    });
}

// Re-export the mismatch error type so callers (and the CLI error renderer) can
// detect stale-anchor rejection without reaching into the algorithm subdir.
export { HashlineMismatchError };
