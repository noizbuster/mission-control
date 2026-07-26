import { repoToolFailure } from './read-tools-errors';
import { isNodeError } from '../util/node-error';
import { errorToString } from '../util/error-to-string';
import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export type WorkspacePath = {
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly stats: Stats;
};

export const referenceRepositoryPath = 'temp/ref-repos';

export const defaultReadOnlyRepoToolDenylist = [
    '.mc/evidence',
    '.nx',
    'dist',
    'build',
    'target',
    'coverage',
    'node_modules',
    '.git',
] as const;

export const directDependencySourcePaths = ['node_modules'] as const;

export const defaultAutomatedDiscoveryDenylist = [...defaultReadOnlyRepoToolDenylist, referenceRepositoryPath] as const;

export type WorkspaceGuardOptions = {
    readonly allowDenylistedPaths?: readonly string[];
    readonly allowDirectDenylistedPaths?: readonly string[];
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
    readonly directAllowedPaths: readonly string[];
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
        throw repoToolFailure('read_failed', errorToString(error));
    }
    ensureInside(root, physicalPath, path);
    ensureNotDenied(root, denylistPolicy, physicalPath, path);

    let physicalStats: Stats;
    try {
        physicalStats = await stat(physicalPath);
    } catch (error: unknown) {
        throw repoToolFailure('read_failed', errorToString(error));
    }

    return {
        absolutePath: physicalPath,
        relativePath: toRelativePath(root, physicalPath),
        stats: physicalStats,
    };
}

function createDenylistPolicy(root: string, options: WorkspaceGuardOptions): WorkspaceDenylistPolicy {
    return {
        allowedPaths: normalizeAllowedDenylistedPaths(root, options.allowDenylistedPaths),
        directAllowedPaths: normalizeAllowedDenylistedPaths(root, options.allowDirectDenylistedPaths),
    };
}

function normalizeAllowedDenylistedPaths(root: string, paths: readonly string[] | undefined): readonly string[] {
    return (paths ?? []).map((path) => normalizeAllowedDenylistedPath(root, path)).sort();
}

function normalizeAllowedDenylistedPath(root: string, path: string): string {
    const relativePath = normalizeRelativePath(root, path);
    if (!matchesWorkspaceDenylist(relativePath)) {
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
        !matchesWorkspaceDenylist(relativePath) ||
        isAllowedDenylistedPath(denylistPolicy.allowedPaths, relativePath) ||
        hasAllowedDenylistedDescendant(denylistPolicy, relativePath)
    );
}

function isDeniedRelativePath(denylistPolicy: WorkspaceDenylistPolicy, relativePath: string): boolean {
    const canonicalPath = canonicalPolicyPath(relativePath);
    if (isAllowedDirectDenylistedPath(denylistPolicy.directAllowedPaths, canonicalPath)) {
        return false;
    }
    return defaultReadOnlyRepoToolDenylist
        .map((entry) => canonicalPolicyPath(entry))
        .filter((entry) => matchesDenylistEntry(entry, canonicalPath))
        .some((entry) => !isAllowedForDenylistEntry(denylistPolicy.allowedPaths, entry, canonicalPath));
}

export function matchesWorkspaceDenylist(relativePath: string): boolean {
    const canonicalPath = canonicalPolicyPath(relativePath);
    return defaultReadOnlyRepoToolDenylist.some((entry) =>
        matchesDenylistEntry(canonicalPolicyPath(entry), canonicalPath),
    );
}

function matchesDenylistEntry(entry: string, relativePath: string): boolean {
    if (entry.includes('/')) {
        return isSameOrDescendant(entry, relativePath);
    }
    return pathSegments(relativePath).includes(entry);
}

function isAllowedDenylistedPath(allowedPaths: readonly string[], relativePath: string): boolean {
    const canonicalPath = canonicalPolicyPath(relativePath);
    return defaultReadOnlyRepoToolDenylist
        .map((entry) => canonicalPolicyPath(entry))
        .filter((entry) => matchesDenylistEntry(entry, canonicalPath))
        .every((entry) => isAllowedForDenylistEntry(allowedPaths, entry, canonicalPath));
}

function isAllowedForDenylistEntry(allowedPaths: readonly string[], entry: string, relativePath: string): boolean {
    return allowedPaths.some((allowedPath) => {
        const canonicalAllowedPath = canonicalPolicyPath(allowedPath);
        return (
            isSameOrDescendant(entry, canonicalAllowedPath) && isSameOrDescendant(canonicalAllowedPath, relativePath)
        );
    });
}

function isAllowedDirectDenylistedPath(allowedPaths: readonly string[], relativePath: string): boolean {
    const canonicalPath = canonicalPolicyPath(relativePath);
    return allowedPaths.some((allowedPath) => {
        const canonicalAllowedPath = canonicalPolicyPath(allowedPath);
        return canonicalAllowedPath.includes('/')
            ? isSameOrDescendant(canonicalAllowedPath, canonicalPath)
            : pathSegments(canonicalPath).includes(canonicalAllowedPath);
    });
}

function hasAllowedDenylistedDescendant(denylistPolicy: WorkspaceDenylistPolicy, relativePath: string): boolean {
    const canonicalPath = canonicalPolicyPath(relativePath);
    return denylistPolicy.allowedPaths.some((allowedPath) =>
        isSameOrDescendant(canonicalPath, canonicalPolicyPath(allowedPath)),
    );
}

function isSameOrDescendant(parent: string, child: string): boolean {
    return parent === '.' || child === parent || child.startsWith(`${parent}/`);
}

function pathSegments(path: string): readonly string[] {
    return path === '.' ? [] : path.split('/');
}

function canonicalPolicyPath(path: string): string {
    const normalized = toPosixPath(path)
        .split('/')
        .filter((segment) => segment.length > 0)
        .join('/')
        .toLowerCase();
    return normalized.length === 0 ? '.' : normalized;
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




