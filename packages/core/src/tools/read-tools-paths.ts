import { repoToolFailure } from './read-tools-errors.js';
import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export type WorkspacePath = {
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly stats: Stats;
};

export const defaultReadOnlyRepoToolDenylist = [
    'temp/ref-repos',
    '.omo/evidence',
    '.nx',
    'dist',
    'build',
    'target',
    'coverage',
    'node_modules',
    '.git',
] as const;

export type WorkspaceGuardOptions = {
    readonly allowDenylistedPaths?: readonly string[];
};

export type WorkspaceGuard = {
    readonly root: string;
    readonly denylistRipgrepGlobs: readonly string[];
    readonly hasAllowedDenylistedPaths: boolean;
    readonly isDeniedAbsolutePath: (path: string) => boolean;
    readonly shouldTraverseAbsolutePath: (path: string) => boolean;
    readonly resolveExisting: (path: string) => Promise<WorkspacePath>;
    readonly relativeFromAbsolute: (path: string) => string;
};

type WorkspaceDenylistPolicy = {
    readonly allowedPaths: readonly string[];
};

const defaultDenylistRipgrepGlobs = defaultReadOnlyRepoToolDenylist.flatMap((entry) => [
    `!${entry}`,
    `!${entry}/**`,
    `!**/${entry}`,
    `!**/${entry}/**`,
]);

export async function createWorkspaceGuard(
    workspaceRoot: string,
    options: WorkspaceGuardOptions = {},
): Promise<WorkspaceGuard> {
    const root = await realpath(resolve(workspaceRoot));
    const denylistPolicy = createDenylistPolicy(root, options);
    return {
        root,
        denylistRipgrepGlobs: defaultDenylistRipgrepGlobs,
        hasAllowedDenylistedPaths: denylistPolicy.allowedPaths.length > 0,
        isDeniedAbsolutePath: (path) => isDeniedAbsolutePath(root, denylistPolicy, path),
        shouldTraverseAbsolutePath: (path) => shouldTraverseAbsolutePath(root, denylistPolicy, path),
        resolveExisting: (path) => resolveExistingWorkspacePath(root, denylistPolicy, path),
        relativeFromAbsolute: (path) => toRelativePath(root, path),
    };
}

export function isBinarySample(bytes: Buffer): boolean {
    if (bytes.length === 0) {
        return false;
    }
    let suspicious = 0;
    for (const byte of bytes) {
        if (byte === 0) {
            return true;
        }
        if (byte < 9 || (byte > 13 && byte < 32)) {
            suspicious += 1;
        }
    }
    return suspicious / bytes.length > 0.3;
}

export function toPosixPath(path: string): string {
    return path.split('\\').join('/');
}

async function resolveExistingWorkspacePath(
    root: string,
    denylistPolicy: WorkspaceDenylistPolicy,
    path: string,
): Promise<WorkspacePath> {
    const lexicalPath = isAbsolute(path) ? resolve(path) : resolve(root, path);
    ensureInside(root, lexicalPath, path);
    ensureNotDenied(root, denylistPolicy, lexicalPath, path);

    let physicalPath: string;
    try {
        physicalPath = await realpath(lexicalPath);
    } catch (error: unknown) {
        if (isNodeError(error, 'ENOENT')) {
            throw repoToolFailure('not_found', `path does not exist: ${path}`);
        }
        throw repoToolFailure('read_failed', errorMessage(error));
    }
    ensureInside(root, physicalPath, path);
    ensureNotDenied(root, denylistPolicy, physicalPath, path);

    let physicalStats: Stats;
    try {
        physicalStats = await stat(physicalPath);
    } catch (error: unknown) {
        throw repoToolFailure('read_failed', errorMessage(error));
    }

    return {
        absolutePath: physicalPath,
        relativePath: toRelativePath(root, physicalPath),
        stats: physicalStats,
    };
}

function createDenylistPolicy(root: string, options: WorkspaceGuardOptions): WorkspaceDenylistPolicy {
    return {
        allowedPaths: (options.allowDenylistedPaths ?? [])
            .map((path) => normalizeAllowedDenylistedPath(root, path))
            .sort(),
    };
}

function normalizeAllowedDenylistedPath(root: string, path: string): string {
    const relativePath = normalizeRelativePath(root, path);
    if (!matchesDenylist(relativePath)) {
        throw repoToolFailure('workspace_denied', `allow path is not denylisted: ${path}`);
    }
    return relativePath;
}

function ensureInside(root: string, path: string, requestedPath: string): void {
    if (!containsPath(root, path)) {
        throw repoToolFailure('workspace_escape', `path escapes workspace: ${requestedPath}`);
    }
}

function ensureNotDenied(
    root: string,
    denylistPolicy: WorkspaceDenylistPolicy,
    path: string,
    requestedPath: string,
): void {
    if (isDeniedAbsolutePath(root, denylistPolicy, path)) {
        throw repoToolFailure('workspace_denied', `path is denied by workspace policy: ${requestedPath}`);
    }
}

function isDeniedAbsolutePath(root: string, denylistPolicy: WorkspaceDenylistPolicy, path: string): boolean {
    return isDeniedRelativePath(denylistPolicy, toRelativePath(root, path));
}

function shouldTraverseAbsolutePath(root: string, denylistPolicy: WorkspaceDenylistPolicy, path: string): boolean {
    const relativePath = toRelativePath(root, path);
    return (
        !matchesDenylist(relativePath) ||
        isAllowedDenylistedPath(denylistPolicy, relativePath) ||
        hasAllowedDenylistedDescendant(denylistPolicy, relativePath)
    );
}

function isDeniedRelativePath(denylistPolicy: WorkspaceDenylistPolicy, relativePath: string): boolean {
    return matchesDenylist(relativePath) && !isAllowedDenylistedPath(denylistPolicy, relativePath);
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

function isAllowedDenylistedPath(denylistPolicy: WorkspaceDenylistPolicy, relativePath: string): boolean {
    return denylistPolicy.allowedPaths.some((allowedPath) => isSameOrDescendant(allowedPath, relativePath));
}

function hasAllowedDenylistedDescendant(denylistPolicy: WorkspaceDenylistPolicy, relativePath: string): boolean {
    return denylistPolicy.allowedPaths.some((allowedPath) => isSameOrDescendant(relativePath, allowedPath));
}

function isSameOrDescendant(parent: string, child: string): boolean {
    return parent === '.' || child === parent || child.startsWith(`${parent}/`);
}

function pathSegments(path: string): readonly string[] {
    return path === '.' ? [] : path.split('/');
}

function normalizeRelativePath(root: string, path: string): string {
    const absolutePath = isAbsolute(path) ? resolve(path) : resolve(root, path);
    ensureInside(root, absolutePath, path);
    return toRelativePath(root, absolutePath);
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
