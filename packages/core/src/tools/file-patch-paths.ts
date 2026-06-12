import { filePatchFailure } from './file-patch-errors.js';
import { defaultReadOnlyRepoToolDenylist, toPosixPath } from './read-tools-paths.js';
import type { Stats } from 'node:fs';
import { mkdir, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export type PatchTarget = {
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly exists: boolean;
    readonly stats?: Stats;
};

export type PatchWorkspaceGuard = {
    readonly root: string;
    readonly resolveTarget: (path: string, mode: 'existing' | 'new') => Promise<PatchTarget>;
};

export async function createPatchWorkspaceGuard(workspaceRoot: string): Promise<PatchWorkspaceGuard> {
    const root = await realpath(resolve(workspaceRoot));
    return {
        root,
        resolveTarget: (path, mode) => resolveTarget(root, path, mode),
    };
}

async function resolveTarget(root: string, path: string, mode: 'existing' | 'new'): Promise<PatchTarget> {
    const lexicalPath = isAbsolute(path) ? resolve(path) : resolve(root, path);
    ensureInside(root, lexicalPath, path);
    ensureNotDenied(root, lexicalPath, path);
    if (mode === 'new') {
        return resolveNewTarget(root, lexicalPath, path);
    }
    return resolveExistingTarget(root, lexicalPath, path);
}

async function resolveExistingTarget(root: string, lexicalPath: string, requestedPath: string): Promise<PatchTarget> {
    let physicalPath: string;
    let stats: Stats;
    try {
        physicalPath = await realpath(lexicalPath);
        stats = await stat(physicalPath);
    } catch (error: unknown) {
        throw filePatchFailure('not_file', errorMessage(error));
    }
    ensureInside(root, physicalPath, requestedPath);
    ensureNotDenied(root, physicalPath, requestedPath);
    if (!stats.isFile()) {
        throw filePatchFailure('not_file', `target is not a file: ${requestedPath}`);
    }
    return { absolutePath: physicalPath, relativePath: toRelativePath(root, physicalPath), exists: true, stats };
}

async function resolveNewTarget(root: string, lexicalPath: string, requestedPath: string): Promise<PatchTarget> {
    try {
        await stat(lexicalPath);
        throw filePatchFailure('target_exists', `target already exists: ${requestedPath}`);
    } catch (error: unknown) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    }
    const parentPath = dirname(lexicalPath);
    const physicalParent = await realpath(parentPath);
    ensureInside(root, physicalParent, requestedPath);
    ensureNotDenied(root, physicalParent, requestedPath);
    await mkdir(physicalParent, { recursive: true });
    return { absolutePath: lexicalPath, relativePath: toRelativePath(root, lexicalPath), exists: false };
}

function ensureInside(root: string, path: string, requestedPath: string): void {
    if (!containsPath(root, path)) {
        throw filePatchFailure('workspace_escape', `path escapes workspace: ${requestedPath}`);
    }
}

function ensureNotDenied(root: string, path: string, requestedPath: string): void {
    if (matchesDenylist(toRelativePath(root, path))) {
        throw filePatchFailure('workspace_denied', `path is denied by workspace policy: ${requestedPath}`);
    }
}

function matchesDenylist(relativePath: string): boolean {
    return defaultReadOnlyRepoToolDenylist.some((entry) => matchesDenylistEntry(entry, relativePath));
}

function matchesDenylistEntry(entry: string, relativePath: string): boolean {
    if (entry.includes('/')) {
        return isSameOrDescendant(entry, relativePath);
    }
    return pathSegments(relativePath).includes(entry);
}

function isSameOrDescendant(parent: string, child: string): boolean {
    return parent === '.' || child === parent || child.startsWith(`${parent}/`);
}

function pathSegments(path: string): readonly string[] {
    return path === '.' ? [] : path.split('/');
}

function containsPath(root: string, path: string): boolean {
    const child = relative(root, path);
    return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

function toRelativePath(root: string, path: string): string {
    const relativePath = relative(root, path);
    return relativePath === '' ? '.' : toPosixPath(relativePath);
}

function isNodeError(error: unknown, code: string): error is { readonly code: string } {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
