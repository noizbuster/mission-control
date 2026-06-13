import type { AgentEvent } from '@mission-control/protocol';
import {
    executeFileMutation,
    fileMutationDiffEvents,
    partialFileMutationAppliedEvents,
    preflightTextFileMutationTargets,
} from './file-mutation.js';
import { applyParsedPatch } from './file-patch-apply.js';
import { filePatchFailure } from './file-patch-errors.js';
import { type ParsedPatchFile, parseUnifiedPatch, targetPath, toDiffFiles } from './file-patch-parser.js';
import { createPatchWorkspaceGuard, type PatchTarget } from './file-patch-paths.js';
import {
    diffFileOutput,
    type FilePatchInput,
    type FilePatchOutput,
    type FilePatchToolOptions,
    filePatchInputSchema,
    filePatchModelOutput,
    filePatchOutputSchema,
    filePatchParametersJsonSchema,
    type ResolvedFilePatchToolOptions,
    resolveFilePatchOptions,
} from './file-patch-schemas.js';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry.js';
import { constants } from 'node:fs';
import { mkdir, open, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

export type { FilePatchToolOptions } from './file-patch-schemas.js';

export async function registerFilePatchTool(
    registry: ToolRegistry,
    options: FilePatchToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(await createFilePatchToolRegistration(options));
}

export async function createFilePatchToolRegistration(
    options: FilePatchToolOptions,
): Promise<ToolRegistration<FilePatchInput, FilePatchOutput>> {
    const resolved = resolveFilePatchOptions(options);
    const guard = await createPatchWorkspaceGuard(resolved.workspaceRoot);
    return {
        name: 'file.patch',
        description: 'Apply an approved unified diff patch inside the workspace.',
        capabilityClasses: ['file.patch'],
        parametersJsonSchema: filePatchParametersJsonSchema(),
        inputSchema: filePatchInputSchema,
        outputSchema: filePatchOutputSchema,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => applyPatchTool(resolved, guard, input, context.toolCallId),
        toModelOutput: filePatchModelOutput,
        toEvents: patchDiffEvents,
    };
}

async function applyPatchTool(
    options: ResolvedFilePatchToolOptions,
    guard: Awaited<ReturnType<typeof createPatchWorkspaceGuard>>,
    input: FilePatchInput,
    toolCallId: string,
): Promise<FilePatchOutput> {
    if (Buffer.byteLength(input.patch, 'utf8') > options.maxPatchBytes) {
        throw filePatchFailure('patch_too_large', `patch exceeds ${options.maxPatchBytes} bytes`);
    }
    const parsedPatch = parseUnifiedPatch(input.patch);
    return executeFileMutation({
        queueKey: guard.root,
        approval: {
            workspaceRoot: options.workspaceRoot,
            toolCallId,
            action: 'file.patch',
            reason: `apply patch to ${parsedPatch.map(targetPath).join(', ')}`,
            permission: 'patch',
            patterns: parsedPatch.map(targetPath),
            requestPermission: options.requestPermission,
        },
        preflight: () =>
            preflightTextFileMutationTargets({
                workspaceRoot: options.workspaceRoot,
                guard,
                targets: parsedPatch.map((file) => ({
                    path: targetPath(file),
                    mode: file.changeKind === 'added' ? 'new' : 'existing',
                })),
                allowDirtyPaths: options.allowDirtyPaths,
            }),
        apply: (targets) => applyTargets(parsedPatch, targets, toolCallId),
    });
}

async function applyTargets(
    parsedPatch: readonly ParsedPatchFile[],
    targets: readonly PatchTarget[],
    toolCallId: string,
): Promise<FilePatchOutput> {
    const appliedFiles: string[] = [];
    const appliedPatchFiles: ParsedPatchFile[] = [];
    for (const [index, file] of parsedPatch.entries()) {
        const target = targets[index];
        if (target === undefined) {
            throw filePatchFailure('patch_apply_failed', `missing target for ${targetPath(file)}`);
        }
        try {
            await applyOneFile(file, target);
            appliedFiles.push(target.relativePath);
            appliedPatchFiles.push(file);
        } catch (error: unknown) {
            const isPartial = appliedFiles.length > 0;
            const message = `${isPartial ? `applied ${appliedFiles.join(', ')}; ` : ''}failed ${
                target.relativePath
            }: ${errorMessage(error)}`;
            throw filePatchFailure(
                isPartial ? 'partial_failed' : 'patch_apply_failed',
                message,
                isPartial ? partialAppliedEvents(toolCallId, appliedPatchFiles) : [],
            );
        }
    }
    return {
        kind: 'file_patch',
        status: 'applied',
        appliedFiles,
        diffFiles: diffFileOutput(toDiffFiles(parsedPatch)),
    };
}

function partialAppliedEvents(
    toolCallId: string,
    appliedPatchFiles: readonly ParsedPatchFile[],
): readonly AgentEvent[] {
    return partialFileMutationAppliedEvents(
        diffFileOutput(toDiffFiles(appliedPatchFiles)),
        toolCallId,
        'patch partially applied',
    );
}

async function applyOneFile(file: ParsedPatchFile, target: PatchTarget): Promise<void> {
    if (file.changeKind === 'deleted') {
        await rm(target.absolutePath);
        return;
    }
    const original = target.exists ? await readExistingFile(target) : '';
    const patched = applyParsedPatch(file, original);
    await writePatchedFile(target, patched);
}

async function readExistingFile(target: PatchTarget): Promise<string> {
    const handle = await open(target.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        return await handle.readFile('utf8');
    } finally {
        await handle.close();
    }
}

async function writePatchedFile(target: PatchTarget, content: string): Promise<void> {
    if ((target.createdParentDirectories?.length ?? 0) > 0) {
        await mkdir(dirname(target.absolutePath), { recursive: true });
    }
    const flags = target.exists
        ? constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW
        : constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const handle = await open(target.absolutePath, flags, 0o666);
    try {
        await handle.writeFile(content, 'utf8');
    } finally {
        await handle.close();
    }
}

function patchDiffEvents(output: FilePatchOutput, context: { readonly toolCallId: string }): readonly AgentEvent[] {
    return fileMutationDiffEvents(output.diffFiles, context.toolCallId, {
        proposed: 'patch proposed',
        applied: 'patch applied',
    });
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
