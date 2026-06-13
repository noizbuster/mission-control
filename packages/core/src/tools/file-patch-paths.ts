import { filePatchFailure } from './file-patch-errors.js';
import { matchesWorkspaceDenylist, toPosixPath } from './read-tools-paths.js';
import type { Stats } from 'node:fs';
import { lstat, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';

export type PatchTarget = {
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly exists: boolean;
    readonly stats?: Stats;
    readonly createdParentDirectories?: readonly string[];
};

export type PatchWorkspaceGuard = {
    readonly root: string;
    readonly resolveTarget: (
        path: string,
        mode: 'existing' | 'new' | 'either',
        options?: { readonly createParentDirectories?: boolean },
    ) => Promise<PatchTarget>;
};

export async function createPatchWorkspaceGuard(workspaceRoot: string): Promise<PatchWorkspaceGuard> {
    const root = await realpath(resolve(workspaceRoot));
    return {
        root,
        resolveTarget: (path, mode, options) => resolveTarget(root, path, mode, options),
    };
}

async function resolveTarget(
    root: string,
    path: string,
    mode: 'existing' | 'new' | 'either',
    options: { readonly createParentDirectories?: boolean } = {},
): Promise<PatchTarget> {
    const lexicalPath = isAbsolute(path) ? resolve(path) : resolve(root, path);
    ensureInside(root, lexicalPath, path);
    ensureNotDenied(root, lexicalPath, path);
    if (mode === 'either') {
        return resolveExistingOrNewTarget(root, lexicalPath, path, options);
    }
    if (mode === 'new') {
        return resolveNewTarget(root, lexicalPath, path, options);
    }
    return resolveExistingTarget(root, lexicalPath, path);
}

async function resolveExistingTarget(root: string, lexicalPath: string, requestedPath: string): Promise<PatchTarget> {
    await assertNoLexicalSymlinkComponents(root, lexicalPath, requestedPath);
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

async function resolveExistingOrNewTarget(
    root: string,
    lexicalPath: string,
    requestedPath: string,
    options: { readonly createParentDirectories?: boolean },
): Promise<PatchTarget> {
    try {
        await lstat(lexicalPath);
        return await resolveExistingTarget(root, lexicalPath, requestedPath);
    } catch (error: unknown) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    }
    return resolveNewTarget(root, lexicalPath, requestedPath, options);
}

async function resolveNewTarget(
    root: string,
    lexicalPath: string,
    requestedPath: string,
    options: { readonly createParentDirectories?: boolean },
): Promise<PatchTarget> {
    try {
        await lstat(lexicalPath);
        throw filePatchFailure('target_exists', `target already exists: ${requestedPath}`);
    } catch (error: unknown) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    }
    const createdParentDirectories = await resolveTargetParent(
        root,
        dirname(lexicalPath),
        requestedPath,
        options.createParentDirectories === true,
    );
    return {
        absolutePath: lexicalPath,
        relativePath: toRelativePath(root, lexicalPath),
        exists: false,
        ...(createdParentDirectories.length > 0 ? { createdParentDirectories } : {}),
    };
}

async function resolveTargetParent(
    root: string,
    parentPath: string,
    requestedPath: string,
    createParentDirectories: boolean,
): Promise<readonly string[]> {
    await assertNoLexicalSymlinkComponents(root, parentPath, requestedPath);
    try {
        const physicalParent = await realpath(parentPath);
        ensureInside(root, physicalParent, requestedPath);
        ensureNotDenied(root, physicalParent, requestedPath);
        return [];
    } catch (error: unknown) {
        if (!isNodeError(error, 'ENOENT')) {
            throw error;
        }
    }
    if (!createParentDirectories) {
        throw filePatchFailure('write_failed', `parent directory does not exist: ${requestedPath}`);
    }
    return collectMissingParents(root, parentPath, requestedPath);
}

async function collectMissingParents(
    root: string,
    parentPath: string,
    requestedPath: string,
): Promise<readonly string[]> {
    const missingParents: string[] = [];
    let probePath = parentPath;
    while (true) {
        try {
            const existingParent = await realpath(probePath);
            ensureInside(root, existingParent, requestedPath);
            ensureNotDenied(root, existingParent, requestedPath);
            return missingParents;
        } catch (error: unknown) {
            if (!isNodeError(error, 'ENOENT')) {
                throw error;
            }
        }
        ensureInside(root, probePath, requestedPath);
        ensureNotDenied(root, probePath, requestedPath);
        missingParents.unshift(toRelativePath(root, probePath));
        const nextProbe = dirname(probePath);
        if (nextProbe === probePath) {
            throw filePatchFailure('workspace_escape', `path escapes workspace: ${requestedPath}`);
        }
        probePath = nextProbe;
    }
}

async function assertNoLexicalSymlinkComponents(
    root: string,
    lexicalPath: string,
    requestedPath: string,
): Promise<void> {
    const relativePath = relative(root, lexicalPath);
    const segments = relativePath === '' ? [] : toPosixPath(relativePath).split('/');
    let probePath = root;
    for (const segment of segments) {
        probePath = resolve(probePath, segment);
        try {
            const stats = await lstat(probePath);
            if (stats.isSymbolicLink()) {
                throw filePatchFailure('workspace_escape', `path escapes workspace: ${requestedPath}`);
            }
        } catch (error: unknown) {
            if (isNodeError(error, 'ENOENT')) {
                return;
            }
            if (isNodeError(error, 'ENOTDIR')) {
                throw filePatchFailure('not_file', `target is not a file: ${requestedPath}`);
            }
            throw error;
        }
    }
}

function ensureInside(root: string, path: string, requestedPath: string): void {
    if (!containsPath(root, path)) {
        throw filePatchFailure('workspace_escape', `path escapes workspace: ${requestedPath}`);
    }
}

function ensureNotDenied(root: string, path: string, requestedPath: string): void {
    if (matchesWorkspaceDenylist(toRelativePath(root, path))) {
        throw filePatchFailure('workspace_denied', `path is denied by workspace policy: ${requestedPath}`);
    }
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
