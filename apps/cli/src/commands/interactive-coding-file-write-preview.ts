import { lstat, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';

export type ParsedFileWritePreview = {
    readonly path: string;
    readonly content: string;
    readonly createParents: boolean;
};

export type ResolvedFileWritePreview = ParsedFileWritePreview & {
    readonly operation: 'blocked' | 'created' | 'replaced';
    readonly blockedReason?: 'path_uses_symlink' | 'workspace_escape';
    readonly originalContent?: string;
};

export function parseFileWritePreviewValue(value: unknown): ParsedFileWritePreview | undefined {
    if (
        !isRecord(value) ||
        typeof value.path !== 'string' ||
        value.path.length === 0 ||
        typeof value.content !== 'string'
    ) {
        return undefined;
    }
    if (value.createParents !== undefined && typeof value.createParents !== 'boolean') {
        return undefined;
    }
    return {
        path: value.path,
        content: value.content,
        createParents: value.createParents === true,
    };
}

export async function buildFileWritePreview(
    parsed: ParsedFileWritePreview,
    workspaceRoot: string | undefined,
): Promise<ResolvedFileWritePreview> {
    if (workspaceRoot === undefined) {
        return { operation: 'created', ...parsed };
    }
    const root = await realpath(resolve(workspaceRoot));
    const absolutePath = isAbsolute(parsed.path) ? resolve(parsed.path) : resolve(root, parsed.path);
    if (!containsPath(root, absolutePath)) {
        return { operation: 'blocked', blockedReason: 'workspace_escape', ...parsed };
    }
    const lexicalInspection = await inspectLexicalPath(root, absolutePath);
    if (lexicalInspection === 'path_uses_symlink') {
        return { operation: 'blocked', blockedReason: 'path_uses_symlink', ...parsed };
    }
    try {
        const lexicalStats = await lstat(absolutePath);
        if (lexicalStats.isSymbolicLink()) {
            return { operation: 'blocked', blockedReason: 'path_uses_symlink', ...parsed };
        }
        if (!lexicalStats.isFile()) {
            return { operation: 'created', ...parsed };
        }
        const physicalPath = await realpath(absolutePath);
        if (physicalPath !== absolutePath || !containsPath(root, physicalPath)) {
            return { operation: 'blocked', blockedReason: 'path_uses_symlink', ...parsed };
        }
        return {
            operation: 'replaced',
            path: parsed.path,
            content: parsed.content,
            createParents: parsed.createParents,
            originalContent: await readFile(absolutePath, 'utf8'),
        };
    } catch {
        return { operation: 'created', ...parsed };
    }
}

export function renderFileWritePreview(parsed: ResolvedFileWritePreview | undefined, fallback: string): string {
    if (parsed === undefined) {
        return fallback;
    }
    if (parsed.operation === 'blocked') {
        return [
            `Target: ${parsed.path}`,
            `Create parent directories: ${parsed.createParents ? 'yes' : 'no'}`,
            `Preview blocked until approval: ${renderBlockedReason(parsed.blockedReason)}`,
        ].join('\n');
    }
    return [
        `Target: ${parsed.path}`,
        `Create parent directories: ${parsed.createParents ? 'yes' : 'no'}`,
        ...(parsed.operation === 'replaced'
            ? [`--- a/${parsed.path}`, ...prefixedLines('-', parsed.originalContent ?? '')]
            : []),
        `+++ b/${parsed.path}`,
        ...prefixedLines('+', parsed.content),
    ].join('\n');
}

export function parseFileWriteOutput(
    value: unknown,
): { readonly appliedFiles: readonly string[]; readonly operation: 'created' | 'replaced' } | undefined {
    if (
        !isRecord(value) ||
        value.kind !== 'file_write' ||
        !Array.isArray(value.appliedFiles) ||
        !value.appliedFiles.every((entry) => typeof entry === 'string') ||
        (value.operation !== 'created' && value.operation !== 'replaced')
    ) {
        return undefined;
    }
    return { appliedFiles: value.appliedFiles, operation: value.operation };
}

function prefixedLines(prefix: string, text: string): readonly string[] {
    const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
    return normalized.split('\n').map((line) => `${prefix}${line}`);
}

function renderBlockedReason(reason: ResolvedFileWritePreview['blockedReason']): string {
    if (reason === 'path_uses_symlink') {
        return 'requested path resolves through a symlink';
    }
    return 'requested path escapes the workspace';
}

function containsPath(root: string, path: string): boolean {
    const child = relative(root, path);
    return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

async function inspectLexicalPath(root: string, absolutePath: string): Promise<'clear' | 'path_uses_symlink'> {
    const relativePath = relative(root, absolutePath);
    const segments = relativePath === '' ? [] : relativePath.split('/');
    let probePath = root;
    for (const segment of segments) {
        probePath = resolve(probePath, segment);
        try {
            const stats = await lstat(probePath);
            if (stats.isSymbolicLink()) {
                return 'path_uses_symlink';
            }
        } catch (error: unknown) {
            if (isNodeError(error, 'ENOENT')) {
                return 'clear';
            }
            throw error;
        }
    }
    return 'clear';
}

function isRecord(value: unknown): value is {
    readonly appliedFiles?: unknown;
    readonly content?: unknown;
    readonly createParents?: unknown;
    readonly kind?: unknown;
    readonly operation?: unknown;
    readonly path?: unknown;
} {
    return typeof value === 'object' && value !== null;
}

function isNodeError(error: unknown, code: string): error is { readonly code: string } {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
