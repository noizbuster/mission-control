import { prepareExactEdit } from './file-edit-operation.js';
import {
    type FileEditInput,
    type FileEditOutput,
    type FileEditToolOptions,
    fileEditDiffOutput,
    fileEditInputSchema,
    fileEditModelOutput,
    fileEditOutputSchema,
    fileEditParametersJsonSchema,
    type ResolvedFileEditToolOptions,
    resolveFileEditOptions,
} from './file-edit-schemas.js';
import { executeFileMutation, fileMutationDiffEvents, preflightTextFileMutationTargets } from './file-mutation.js';
import { filePatchFailure } from './file-patch-errors.js';
import { createPatchWorkspaceGuard, type PatchTarget } from './file-patch-paths.js';
import { type ToolAdvertisement, type ToolRegistration, ToolRegistry } from './tool-registry.js';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

export type { FileEditToolOptions } from './file-edit-schemas.js';

export async function registerFileEditTool(
    registry: ToolRegistry,
    options: FileEditToolOptions,
): Promise<ToolAdvertisement> {
    return registry.register(await createFileEditToolRegistration(options));
}

export async function createFileEditToolRegistration(
    options: FileEditToolOptions,
): Promise<ToolRegistration<FileEditInput, FileEditOutput>> {
    const resolved = resolveFileEditOptions(options);
    const guard = await createPatchWorkspaceGuard(resolved.workspaceRoot);
    return {
        name: 'file.edit',
        description: 'Replace exact text in an existing workspace file.',
        capabilityClasses: ['file.edit'],
        parametersJsonSchema: fileEditParametersJsonSchema(),
        inputSchema: fileEditInputSchema,
        outputSchema: fileEditOutputSchema,
        outputLimit: { maxModelOutputChars: resolved.maxModelOutputChars },
        execute: (input, context) => applyFileEditTool(resolved, guard, input, context.toolCallId),
        toModelOutput: fileEditModelOutput,
        toEvents: editDiffEvents,
    };
}

async function applyFileEditTool(
    options: ResolvedFileEditToolOptions,
    guard: Awaited<ReturnType<typeof createPatchWorkspaceGuard>>,
    input: FileEditInput,
    toolCallId: string,
): Promise<FileEditOutput> {
    return executeFileMutation({
        queueKey: guard.root,
        approval: {
            workspaceRoot: options.workspaceRoot,
            toolCallId,
            action: 'file.edit',
            reason: `edit exact text in ${input.path}`,
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
        apply: async (targets) => applyExactEdit(input, requireSingleTarget(targets)),
    });
}

async function applyExactEdit(input: FileEditInput, target: PatchTarget): Promise<FileEditOutput> {
    const originalContent = await readExistingFile(target);
    const prepared = prepareExactEdit(input, target.relativePath, originalContent);
    await writeEditedFile(target, prepared.updatedContent);
    return {
        kind: 'file_edit',
        status: 'applied',
        appliedFiles: [target.relativePath],
        occurrencesReplaced: prepared.occurrencesReplaced,
        diffFiles: fileEditDiffOutput(prepared.diffFiles),
    };
}

function requireSingleTarget(targets: readonly PatchTarget[]): PatchTarget {
    const target = targets[0];
    if (target === undefined) {
        throw filePatchFailure('write_failed', 'missing file.edit target');
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
    const handle = await open(target.absolutePath, constants.O_WRONLY | constants.O_TRUNC | constants.O_NOFOLLOW);
    try {
        await handle.writeFile(content, 'utf8');
    } finally {
        await handle.close();
    }
}

function editDiffEvents(output: FileEditOutput, context: { readonly toolCallId: string }) {
    return fileMutationDiffEvents(output.diffFiles, context.toolCallId, {
        proposed: 'edit proposed',
        applied: 'edit applied',
    });
}
