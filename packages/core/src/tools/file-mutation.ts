import type {
    AgentEvent,
    DiffFile,
    PermissionDecision,
    PermissionKind,
    PermissionRequest,
} from '@mission-control/protocol';
import { assertTextPatchTarget } from './file-patch-binary.js';
import { filePatchFailure } from './file-patch-errors.js';
import { isDirtyTrackedTarget } from './file-patch-git.js';
import type { PatchTarget, PatchWorkspaceGuard } from './file-patch-paths.js';
import { permissionRequest, requestToolPermission } from './tool-permissions.js';

type WorkspaceMutationQueueEntry = {
    readonly token: symbol;
    readonly tail: Promise<void>;
};

const workspaceMutationQueue = new Map<string, WorkspaceMutationQueueEntry>();

export type FileMutationTargetDescriptor = {
    readonly path: string;
    readonly mode: 'existing' | 'new' | 'either';
    readonly createParentDirectories?: boolean;
};

export type FileMutationTarget = Pick<PatchTarget, 'absolutePath' | 'relativePath' | 'exists'>;

export type FileMutationApproval = {
    readonly workspaceRoot: string;
    readonly toolCallId: string;
    readonly action: string;
    readonly reason: string;
    readonly permission: PermissionKind;
    readonly patterns: readonly string[];
    readonly requestPermission: (request: PermissionRequest) => PermissionDecision | Promise<PermissionDecision>;
};

export type FileMutationExecutionOptions<TTarget extends FileMutationTarget, TResult> = {
    readonly queueKey: string;
    readonly approval: FileMutationApproval;
    readonly preflight: () => Promise<readonly TTarget[]>;
    readonly apply: (targets: readonly TTarget[]) => Promise<TResult>;
};

export type FileMutationDiffMessages = {
    readonly proposed: string;
    readonly applied: string;
};

export async function preflightTextFileMutationTargets(input: {
    readonly workspaceRoot: string;
    readonly guard: PatchWorkspaceGuard;
    readonly targets: readonly FileMutationTargetDescriptor[];
    readonly allowDirtyPaths: readonly string[];
}): Promise<readonly PatchTarget[]> {
    const resolvedTargets: PatchTarget[] = [];
    for (const descriptor of input.targets) {
        const target = await input.guard.resolveTarget(descriptor.path, descriptor.mode, {
            ...(descriptor.createParentDirectories !== undefined
                ? { createParentDirectories: descriptor.createParentDirectories }
                : {}),
        });
        await assertTextPatchTarget(target);
        if (
            target.exists &&
            !input.allowDirtyPaths.includes(target.relativePath) &&
            (await isDirtyTrackedTarget(input.workspaceRoot, target.relativePath))
        ) {
            throw filePatchFailure('dirty_target', `dirty tracked target refused: ${target.relativePath}`);
        }
        resolvedTargets.push(target);
    }
    return resolvedTargets;
}

export async function executeFileMutation<TTarget extends FileMutationTarget, TResult>(
    options: FileMutationExecutionOptions<TTarget, TResult>,
): Promise<TResult> {
    return runSerializedWorkspaceMutation(options.queueKey, async () => {
        const approvedTargets = await options.preflight();
        await requireMutationApproval(options.approval);
        const revalidatedTargets = await options.preflight();
        assertStableMutationTargets(approvedTargets, revalidatedTargets);
        return options.apply(revalidatedTargets);
    });
}

export function fileMutationDiffEvents(
    diffFiles: readonly DiffFile[],
    toolCallId: string,
    messages: FileMutationDiffMessages,
): readonly AgentEvent[] {
    const timestamp = new Date().toISOString();
    return [
        diffEvent('file.diff.proposed', timestamp, toolCallId, messages.proposed, diffFiles),
        diffEvent('file.diff.applied', timestamp, toolCallId, messages.applied, diffFiles),
    ];
}

export function partialFileMutationAppliedEvents(
    diffFiles: readonly DiffFile[],
    toolCallId: string,
    message: string,
): readonly AgentEvent[] {
    return [diffEvent('file.diff.applied', new Date().toISOString(), toolCallId, message, diffFiles)];
}

async function requireMutationApproval(approval: FileMutationApproval): Promise<void> {
    const request = permissionRequest({
        toolCallId: approval.toolCallId,
        action: approval.action,
        reason: approval.reason,
        permission: approval.permission,
        patterns: approval.patterns,
        workspaceRoot: approval.workspaceRoot,
    });
    const decision = await requestToolPermission(approval.requestPermission, request);
    if (decision.status === 'allow') {
        return;
    }
    throw filePatchFailure(errorCodeForDecision(decision), decision.reason ?? `approval refused: ${decision.status}`);
}

function assertStableMutationTargets(
    approvedTargets: readonly FileMutationTarget[],
    revalidatedTargets: readonly FileMutationTarget[],
): void {
    if (approvedTargets.length !== revalidatedTargets.length) {
        throw filePatchFailure('patch_apply_failed', 'patch target count changed after approval');
    }
    for (const [index, approvedTarget] of approvedTargets.entries()) {
        const revalidatedTarget = revalidatedTargets[index];
        if (revalidatedTarget === undefined) {
            throw filePatchFailure(
                'patch_apply_failed',
                `missing revalidated target for ${approvedTarget.relativePath}`,
            );
        }
        if (
            approvedTarget.absolutePath !== revalidatedTarget.absolutePath ||
            approvedTarget.relativePath !== revalidatedTarget.relativePath ||
            approvedTarget.exists !== revalidatedTarget.exists
        ) {
            throw filePatchFailure('workspace_escape', `target changed after approval: ${approvedTarget.relativePath}`);
        }
    }
}

async function runSerializedWorkspaceMutation<TResult>(
    queueKey: string,
    operation: () => Promise<TResult>,
): Promise<TResult> {
    const previousTail = workspaceMutationQueue.get(queueKey)?.tail ?? Promise.resolve();
    const release = createQueueRelease();
    const token = Symbol(queueKey);
    const currentTail = previousTail.catch(swallowQueueFailure).then(() => release.promise);
    workspaceMutationQueue.set(queueKey, { token, tail: currentTail });
    await previousTail.catch(swallowQueueFailure);
    try {
        return await operation();
    } finally {
        release.resolve();
        const activeEntry = workspaceMutationQueue.get(queueKey);
        if (activeEntry?.token === token) {
            void currentTail.finally(() => {
                const latestEntry = workspaceMutationQueue.get(queueKey);
                if (latestEntry?.token === token) {
                    workspaceMutationQueue.delete(queueKey);
                }
            });
        }
    }
}

function createQueueRelease(): { readonly promise: Promise<void>; readonly resolve: () => void } {
    let resolvePromise: (() => void) | undefined;
    const promise = new Promise<void>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: () => {
            resolvePromise?.();
        },
    };
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

function swallowQueueFailure(): void {}
