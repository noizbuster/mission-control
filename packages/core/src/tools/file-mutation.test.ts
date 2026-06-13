import type { PermissionDecision, PermissionRequest } from '@mission-control/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { executeFileMutation, type FileMutationTarget, preflightTextFileMutationTargets } from './file-mutation.js';
import { createPatchWorkspaceGuard } from './file-patch-paths.js';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

describe('file mutation preflight and serialization', () => {
    const workspaces: string[] = [];

    afterEach(async () => {
        await Promise.all(workspaces.map((workspace) => rm(workspace, { recursive: true, force: true })));
        workspaces.length = 0;
    });

    it('rejects symlink escapes during shared preflight', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        const outsideRoot = await createWorkspace();
        await writeFile(join(outsideRoot, 'secret.txt'), 'secret\n', 'utf8');
        await symlink(join(outsideRoot, 'secret.txt'), join(workspaceRoot, 'link.txt'));
        const guard = await createPatchWorkspaceGuard(workspaceRoot);

        // When
        const result = preflightTextFileMutationTargets({
            workspaceRoot,
            guard,
            targets: [{ path: 'link.txt', mode: 'existing' }],
            allowDirtyPaths: [],
        });

        // Then
        await expect(result).rejects.toThrow(/workspace_escape/);
        expect(await readText(outsideRoot, 'secret.txt')).toBe('secret\n');
    });

    it('rejects dirty tracked targets during shared preflight', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before\n');
        await writeFile(join(workspaceRoot, 'notes.txt'), 'dirty\n', 'utf8');
        const guard = await createPatchWorkspaceGuard(workspaceRoot);

        // When
        const result = preflightTextFileMutationTargets({
            workspaceRoot,
            guard,
            targets: [{ path: 'notes.txt', mode: 'existing' }],
            allowDirtyPaths: [],
        });

        // Then
        await expect(result).rejects.toThrow(/dirty_target/);
        expect(await readText(workspaceRoot, 'notes.txt')).toBe('dirty\n');
    });

    it('revalidates targets after approval before applying', async () => {
        // Given
        const workspaceRoot = await createGitWorkspace();
        await trackedFile(workspaceRoot, 'notes.txt', 'before\n');
        const guard = await createPatchWorkspaceGuard(workspaceRoot);
        let applyCount = 0;

        // When
        const result = executeFileMutation({
            queueKey: guard.root,
            approval: {
                workspaceRoot,
                toolCallId: 'patch_call',
                action: 'file.patch',
                reason: 'apply patch to notes.txt',
                permission: 'patch',
                patterns: ['notes.txt'],
                requestPermission: async (request) => {
                    await unlink(join(workspaceRoot, 'notes.txt'));
                    return allowPermission(request);
                },
            },
            preflight: () =>
                preflightTextFileMutationTargets({
                    workspaceRoot,
                    guard,
                    targets: [{ path: 'notes.txt', mode: 'existing' }],
                    allowDirtyPaths: [],
                }),
            apply: async (targets) => {
                applyCount += 1;
                return { targets };
            },
        });

        // Then
        await expect(result).rejects.toThrow(/not_file/);
        expect(applyCount).toBe(0);
    });

    it('serializes concurrent mutations per workspace queue', async () => {
        // Given
        const phases: string[] = [];
        const releaseFirstApproval = createDeferred<void>();
        const firstApprovalSeen = createDeferred<void>();

        // When
        const first = executeFileMutation({
            queueKey: 'workspace-queue',
            approval: approvalFor('first', async (request) => {
                phases.push('first:approval');
                firstApprovalSeen.resolve();
                await releaseFirstApproval.promise;
                return allowPermission(request);
            }),
            preflight: async () => {
                phases.push('first:preflight');
                return [mutationTarget('first.txt')];
            },
            apply: async (targets) => {
                phases.push('first:apply');
                return targets[0]?.relativePath ?? 'missing';
            },
        });
        await firstApprovalSeen.promise;

        const second = executeFileMutation({
            queueKey: 'workspace-queue',
            approval: approvalFor('second', async (request) => {
                phases.push('second:approval');
                return allowPermission(request);
            }),
            preflight: async () => {
                phases.push('second:preflight');
                return [mutationTarget('second.txt')];
            },
            apply: async (targets) => {
                phases.push('second:apply');
                return targets[0]?.relativePath ?? 'missing';
            },
        });
        await Promise.resolve();
        await Promise.resolve();

        // Then
        expect(phases).toEqual(['first:preflight', 'first:approval']);
        releaseFirstApproval.resolve();
        await expect(Promise.all([first, second])).resolves.toEqual(['first.txt', 'second.txt']);
        expect(phases).toEqual([
            'first:preflight',
            'first:approval',
            'first:preflight',
            'first:apply',
            'second:preflight',
            'second:approval',
            'second:preflight',
            'second:apply',
        ]);
    });

    async function createWorkspace(): Promise<string> {
        const workspace = await mkdtemp(join(tmpdir(), 'mctrl-file-mutation-'));
        workspaces.push(workspace);
        return workspace;
    }

    async function createGitWorkspace(): Promise<string> {
        const workspace = await createWorkspace();
        await execFileAsync('git', ['init'], { cwd: workspace });
        await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: workspace });
        await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: workspace });
        return workspace;
    }
});

function approvalFor(
    toolCallId: string,
    requestPermission: (request: PermissionRequest) => Promise<PermissionDecision>,
) {
    return {
        workspaceRoot: '/workspace',
        toolCallId,
        action: 'file.patch',
        reason: `apply patch to ${toolCallId}.txt`,
        permission: 'patch' as const,
        patterns: [`${toolCallId}.txt`],
        requestPermission,
    };
}

async function trackedFile(workspaceRoot: string, path: string, content: string): Promise<void> {
    await writeFile(join(workspaceRoot, path), content, 'utf8');
    await execFileAsync('git', ['add', path], { cwd: workspaceRoot });
    await execFileAsync('git', ['commit', '-m', `add ${path}`], { cwd: workspaceRoot });
}

function allowPermission(request: PermissionRequest): PermissionDecision {
    return { requestId: request.id, status: 'allow', reason: 'test allow' };
}

function createDeferred<T>(): { readonly promise: Promise<T>; readonly resolve: (value: T) => void } {
    let resolvePromise: ((value: T) => void) | undefined;
    const promise = new Promise<T>((resolve) => {
        resolvePromise = resolve;
    });
    return {
        promise,
        resolve: (value) => {
            resolvePromise?.(value);
        },
    };
}

function mutationTarget(relativePath: string): FileMutationTarget {
    return { absolutePath: join('/workspace', relativePath), relativePath, exists: true };
}

async function readText(workspaceRoot: string, path: string): Promise<string> {
    return readFile(join(workspaceRoot, path), 'utf8');
}
