import { repoToolFailure } from './read-tools-errors.js';
import type { Stats } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export type WorkspacePath = {
    readonly absolutePath: string;
    readonly relativePath: string;
    readonly stats: Stats;
};

export type WorkspaceGuard = {
    readonly root: string;
    readonly resolveExisting: (path: string) => Promise<WorkspacePath>;
    readonly relativeFromAbsolute: (path: string) => string;
};

export async function createWorkspaceGuard(workspaceRoot: string): Promise<WorkspaceGuard> {
    const root = await realpath(resolve(workspaceRoot));
    return {
        root,
        resolveExisting: (path) => resolveExistingWorkspacePath(root, path),
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

async function resolveExistingWorkspacePath(root: string, path: string): Promise<WorkspacePath> {
    const lexicalPath = isAbsolute(path) ? resolve(path) : resolve(root, path);
    ensureInside(root, lexicalPath, path);

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

function ensureInside(root: string, path: string, requestedPath: string): void {
    if (!containsPath(root, path)) {
        throw repoToolFailure('workspace_escape', `path escapes workspace: ${requestedPath}`);
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
