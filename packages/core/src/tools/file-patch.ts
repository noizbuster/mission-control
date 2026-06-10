import type { AgentEvent, DiffFile, PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { applyParsedPatch } from './file-patch-apply.js';
import { filePatchFailure } from './file-patch-errors.js';
import { isDirtyTrackedTarget } from './file-patch-git.js';
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
import { open, rm } from 'node:fs/promises';

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
    const targets = await preflightTargets(options.workspaceRoot, guard, parsedPatch, options.allowDirtyPaths);
    await requireApproval(options, toolCallId, parsedPatch);
    return applyTargets(parsedPatch, targets);
}

async function preflightTargets(
    workspaceRoot: string,
    guard: Awaited<ReturnType<typeof createPatchWorkspaceGuard>>,
    parsedPatch: readonly ParsedPatchFile[],
    allowDirtyPaths: readonly string[],
): Promise<readonly PatchTarget[]> {
    const targets: PatchTarget[] = [];
    for (const file of parsedPatch) {
        const mode = file.changeKind === 'added' ? 'new' : 'existing';
        const target = await guard.resolveTarget(targetPath(file), mode);
        if (
            target.exists &&
            !allowDirtyPaths.includes(target.relativePath) &&
            (await isDirtyTrackedTarget(workspaceRoot, target.relativePath))
        ) {
            throw filePatchFailure('dirty_target', `dirty tracked target refused: ${target.relativePath}`);
        }
        targets.push(target);
    }
    return targets;
}

async function requireApproval(
    options: ResolvedFilePatchToolOptions,
    toolCallId: string,
    parsedPatch: readonly ParsedPatchFile[],
): Promise<void> {
    const request: PermissionRequest = {
        id: `permission_${toolCallId}`,
        action: 'file.patch',
        reason: `apply patch to ${parsedPatch.map(targetPath).join(', ')}`,
    };
    const decision = await options.requestPermission(request);
    if (decision.status === 'allow') {
        return;
    }
    throw filePatchFailure(errorCodeForDecision(decision), decision.reason ?? `approval refused: ${decision.status}`);
}

async function applyTargets(
    parsedPatch: readonly ParsedPatchFile[],
    targets: readonly PatchTarget[],
): Promise<FilePatchOutput> {
    const appliedFiles: string[] = [];
    for (const [index, file] of parsedPatch.entries()) {
        const target = targets[index];
        if (target === undefined) {
            throw filePatchFailure('patch_apply_failed', `missing target for ${targetPath(file)}`);
        }
        try {
            await applyOneFile(file, target);
            appliedFiles.push(target.relativePath);
        } catch (error: unknown) {
            throw filePatchFailure(
                appliedFiles.length > 0 ? 'partial_failed' : 'patch_apply_failed',
                `${appliedFiles.length > 0 ? `applied ${appliedFiles.join(', ')}; ` : ''}failed ${
                    target.relativePath
                }: ${errorMessage(error)}`,
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
    const timestamp = new Date().toISOString();
    return [
        diffEvent('file.diff.proposed', timestamp, context.toolCallId, 'patch proposed', output.diffFiles),
        diffEvent('file.diff.applied', timestamp, context.toolCallId, 'patch applied', output.diffFiles),
    ];
}

function diffEvent(
    type: 'file.diff.proposed' | 'file.diff.applied',
    timestamp: string,
    toolCallId: string,
    message: string,
    diffFiles: readonly DiffFile[],
): AgentEvent {
    return {
        type,
        timestamp,
        taskId: toolCallId,
        message,
        nativeSidecarStatus: 'mock',
        diffFiles: [...diffFiles],
    };
}

function errorCodeForDecision(decision: PermissionDecision): 'approval_denied' | 'approval_required' {
    return decision.status === 'deny' ? 'approval_denied' : 'approval_required';
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
