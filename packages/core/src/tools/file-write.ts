import type { DiffFile, DiffLine } from '@mission-control/protocol';
import { executeFileMutation, fileMutationDiffEvents, preflightTextFileMutationTargets } from './file-mutation.js';
import { filePatchFailure } from './file-patch-errors.js';
import { createPatchWorkspaceGuard, type PatchTarget } from './file-patch-paths.js';
import {
    type FileWriteInput,
    type FileWriteOutput,
    type FileWriteToolOptions,
    fileWriteDiffOutput,
    fileWriteInputSchema,
    fileWriteModelOutput,
    fileWriteOutputSchema,
    fileWriteParametersJsonSchema,
    type ResolvedFileWriteToolOptions,
    resolveFileWriteOptions,
} from './file-write-schemas.js';
import { isBinarySample } from './read-tools-paths.js';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry.js';
import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { dirname } from 'node:path';

export type { FileWriteToolOptions } from './file-write-schemas.js';

export async function registerFileWriteTool(
    registry: ToolRegistry,
    options: FileWriteToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(await createFileWriteToolRegistration(options));
}

export async function createFileWriteToolRegistration(
    options: FileWriteToolOptions,
): Promise<ToolRegistration<FileWriteInput, FileWriteOutput>> {
    const resolved = resolveFileWriteOptions(options);
    const guard = await createPatchWorkspaceGuard(resolved.workspaceRoot);
    return {
        name: 'file.write',
        description: 'Create a new text file or replace the full contents of an existing workspace file.',
        capabilityClasses: ['file.write'],
        parametersJsonSchema: fileWriteParametersJsonSchema(),
        inputSchema: fileWriteInputSchema,
        outputSchema: fileWriteOutputSchema,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => applyFileWriteTool(resolved, guard, input, context.toolCallId),
        toModelOutput: fileWriteModelOutput,
        toEvents: writeDiffEvents,
    };
}

async function applyFileWriteTool(
    options: ResolvedFileWriteToolOptions,
    guard: Awaited<ReturnType<typeof createPatchWorkspaceGuard>>,
    input: FileWriteInput,
    toolCallId: string,
): Promise<FileWriteOutput> {
    assertTextWriteContent(input.content, input.path);
    return executeFileMutation({
        queueKey: guard.root,
        approval: {
            workspaceRoot: options.workspaceRoot,
            toolCallId,
            action: 'file.write',
            reason:
                input.createParents === true
                    ? `write full contents to ${input.path} and create parent directories`
                    : `write full contents to ${input.path}`,
            permission: 'write',
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
                        createParentDirectories: input.createParents === true,
                    },
                ],
                allowDirtyPaths: options.allowDirtyPaths,
            }),
        apply: async (targets) => applyWrite(input.content, requireSingleTarget(targets)),
    });
}

async function applyWrite(content: string, target: PatchTarget): Promise<FileWriteOutput> {
    const originalContent = target.exists ? await readExistingFile(target) : '';
    await ensureParentDirectories(target);
    await writeTargetFile(target, content);
    return {
        kind: 'file_write',
        status: 'applied',
        operation: target.exists ? 'replaced' : 'created',
        appliedFiles: [target.relativePath],
        createdParentDirectories: [...(target.createdParentDirectories ?? [])],
        diffFiles: fileWriteDiffOutput([
            diffFileForWrite(target.relativePath, originalContent, content, target.exists),
        ]),
    };
}

function requireSingleTarget(targets: readonly PatchTarget[]): PatchTarget {
    const target = targets[0];
    if (target === undefined) {
        throw filePatchFailure('write_failed', 'missing file.write target');
    }
    return target;
}

function assertTextWriteContent(content: string, path: string): void {
    if (isBinarySample(Buffer.from(content, 'utf8'))) {
        throw filePatchFailure('binary_file', `binary content refused: ${path}`);
    }
}

async function readExistingFile(target: PatchTarget): Promise<string> {
    const handle = await open(target.absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
        return await handle.readFile('utf8');
    } finally {
        await handle.close();
    }
}

async function ensureParentDirectories(target: PatchTarget): Promise<void> {
    if ((target.createdParentDirectories?.length ?? 0) === 0) {
        return;
    }
    await mkdir(dirname(target.absolutePath), { recursive: true });
}

async function writeTargetFile(target: PatchTarget, content: string): Promise<void> {
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

function diffFileForWrite(
    relativePath: string,
    originalContent: string,
    nextContent: string,
    existed: boolean,
): DiffFile {
    return {
        filePath: relativePath,
        changeKind: existed ? 'modified' : 'added',
        hunks: [
            {
                oldStart: 1,
                oldLines: countLogicalLines(originalContent),
                newStart: 1,
                newLines: countLogicalLines(nextContent),
                lines: [...toDiffLines('removed', originalContent), ...toDiffLines('added', nextContent)],
            },
        ],
    };
}

function writeDiffEvents(output: FileWriteOutput, context: { readonly toolCallId: string }) {
    const operation = output.operation === 'created' ? 'create' : 'replace';
    return fileMutationDiffEvents(output.diffFiles, context.toolCallId, {
        proposed: `${operation} proposed`,
        applied: `${operation} applied`,
    });
}

function countLogicalLines(text: string): number {
    if (text.length === 0) {
        return 0;
    }
    return text.endsWith('\n') ? text.slice(0, -1).split('\n').length : text.split('\n').length;
}

function toDiffLines(kind: DiffLine['kind'], text: string): readonly DiffLine[] {
    if (text.length === 0) {
        return [];
    }
    const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
    return normalized.split('\n').map((content) => ({ kind, content }));
}
