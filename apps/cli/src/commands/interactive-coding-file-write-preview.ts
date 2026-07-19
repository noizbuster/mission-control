import { FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES } from '@mission-control/core';
import { type FileHandle, lstat, open, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

export const FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES = 64 * 1024;
export { FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES };

export type BoundedFileWriteBody = {
    readonly text: string;
    readonly originalBytes: number;
    readonly returnedBytes: number;
    readonly truncated: boolean;
};

export type FileWriteArgumentsPreview =
    | { readonly kind: 'parseable' }
    | { readonly kind: 'raw'; readonly body: BoundedFileWriteBody };

type LexicalPathInspection = 'clear' | 'path_uses_symlink' | 'target_unreadable';

export type ParsedFileWritePreview = {
    readonly path: string;
    readonly proposedContent: BoundedFileWriteBody;
    readonly createParents: boolean;
};

export type ResolvedFileWritePreview = ParsedFileWritePreview & {
    readonly operation: 'blocked' | 'created' | 'replaced';
    readonly blockedReason?: 'path_uses_symlink' | 'workspace_escape' | 'target_not_file' | 'target_unreadable';
    readonly existingContent?: BoundedFileWriteBody;
};

export function prepareFileWriteArgumentsPreview(argumentsJson: string): FileWriteArgumentsPreview {
    const originalBytes = Buffer.byteLength(argumentsJson, 'utf8');
    if (originalBytes <= FILE_WRITE_ARGUMENTS_PARSE_BUDGET_BYTES) return { kind: 'parseable' };
    return { kind: 'raw', body: boundFileWriteDisplayBody(argumentsJson, originalBytes) };
}

export function boundFileWriteDisplayBody(
    text: string,
    originalBytes = Buffer.byteLength(text, 'utf8'),
): BoundedFileWriteBody {
    let returnedBytes = 0;
    let endIndex = 0;
    for (const character of text) {
        const characterBytes = Buffer.byteLength(character, 'utf8');
        if (returnedBytes + characterBytes > FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES) break;
        returnedBytes += characterBytes;
        endIndex += character.length;
    }
    const boundedText = Buffer.from(text.slice(0, endIndex), 'utf8').toString('utf8');
    return {
        text: boundedText,
        originalBytes,
        returnedBytes: Buffer.byteLength(boundedText, 'utf8'),
        truncated: returnedBytes < originalBytes,
    };
}

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
        proposedContent: boundFileWriteDisplayBody(value.content),
        createParents: value.createParents === true,
    };
}

export async function buildFileWritePreview(
    parsed: ParsedFileWritePreview,
    workspaceRoot: string | undefined,
): Promise<ResolvedFileWritePreview> {
    if (workspaceRoot === undefined) {
        return { operation: 'blocked', blockedReason: 'target_unreadable', ...parsed };
    }
    const root = await realpath(resolve(workspaceRoot));
    const absolutePath = isAbsolute(parsed.path) ? resolve(parsed.path) : resolve(root, parsed.path);
    if (!containsPath(root, absolutePath)) {
        return { operation: 'blocked', blockedReason: 'workspace_escape', ...parsed };
    }
    const lexicalInspection = await inspectLexicalPath(root, absolutePath);
    if (lexicalInspection !== 'clear') {
        return { operation: 'blocked', blockedReason: lexicalInspection, ...parsed };
    }
    let lexicalStats: Awaited<ReturnType<typeof lstat>>;
    try {
        lexicalStats = await lstat(absolutePath);
    } catch (error: unknown) {
        if (isNodeError(error, 'ENOENT')) return { operation: 'created', ...parsed };
        if (error instanceof Error) {
            return { operation: 'blocked', blockedReason: 'target_unreadable', ...parsed };
        }
        throw error;
    }
    if (lexicalStats.isSymbolicLink()) {
        return { operation: 'blocked', blockedReason: 'path_uses_symlink', ...parsed };
    }
    if (!lexicalStats.isFile()) {
        return { operation: 'blocked', blockedReason: 'target_not_file', ...parsed };
    }
    try {
        const physicalPath = await realpath(absolutePath);
        if (physicalPath !== absolutePath || !containsPath(root, physicalPath)) {
            return { operation: 'blocked', blockedReason: 'path_uses_symlink', ...parsed };
        }
        const existingContent = await readExistingContent(absolutePath);
        if (existingContent === undefined) return { operation: 'blocked', blockedReason: 'target_not_file', ...parsed };
        return {
            operation: 'replaced',
            ...parsed,
            existingContent,
        };
    } catch (error: unknown) {
        if (error instanceof Error) {
            return { operation: 'blocked', blockedReason: 'target_unreadable', ...parsed };
        }
        throw error;
    }
}

export function renderFileWritePreview(
    parsed: ResolvedFileWritePreview | undefined,
    fallback: BoundedFileWriteBody,
): string {
    if (parsed === undefined) {
        return renderRawFileWriteArguments(fallback);
    }
    if (parsed.operation === 'blocked') {
        return [
            `Target: ${parsed.path}`,
            `Create parent directories: ${parsed.createParents ? 'yes' : 'no'}`,
            renderBlockedReason(parsed.blockedReason),
        ].join('\n');
    }
    return [
        `Target: ${parsed.path}`,
        `Create parent directories: ${parsed.createParents ? 'yes' : 'no'}`,
        ...(parsed.operation === 'replaced'
            ? [
                  `--- a/${parsed.path}`,
                  ...prefixedLines('-', parsed.existingContent?.text ?? ''),
                  ...renderBodyTruncation('Existing content', parsed.existingContent),
              ]
            : []),
        `+++ b/${parsed.path}`,
        ...prefixedLines('+', parsed.proposedContent.text),
        ...renderBodyTruncation('Proposed content', parsed.proposedContent),
    ].join('\n');
}

export function renderRawFileWriteArguments(body: BoundedFileWriteBody): string {
    return [
        `Raw arguments: ${body.returnedBytes}/${body.originalBytes} bytes${body.truncated ? ' (truncated)' : ''}`,
        body.text,
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

function renderBodyTruncation(label: string, body: BoundedFileWriteBody | undefined): readonly string[] {
    if (body?.truncated !== true) return [];
    return [`${label}: ${body.returnedBytes}/${body.originalBytes} bytes (truncated)`];
}

async function readExistingContent(path: string): Promise<BoundedFileWriteBody | undefined> {
    const handle = await open(path, 'r');
    try {
        const stats = await handle.stat();
        if (!stats.isFile()) return undefined;
        const requestedBytes = Math.min(stats.size, FILE_WRITE_DISPLAY_BODY_BUDGET_BYTES);
        const bytes = await readPrefix(handle, requestedBytes);
        const decoder = new StringDecoder('utf8');
        return boundFileWriteDisplayBody(decoder.write(bytes), stats.size);
    } finally {
        await handle.close();
    }
}

async function readPrefix(handle: FileHandle, requestedBytes: number): Promise<Buffer> {
    const buffer = Buffer.alloc(requestedBytes);
    let returnedBytes = 0;
    while (returnedBytes < requestedBytes) {
        const result = await handle.read(buffer, returnedBytes, requestedBytes - returnedBytes, returnedBytes);
        if (result.bytesRead === 0) break;
        returnedBytes += result.bytesRead;
    }
    return buffer.subarray(0, returnedBytes);
}

function renderBlockedReason(reason: ResolvedFileWritePreview['blockedReason']): string {
    if (reason === 'target_not_file') return 'Preview unavailable: target is not a regular file';
    if (reason === 'target_unreadable') return 'Preview unavailable: target could not be read';
    if (reason === 'path_uses_symlink') {
        return 'Preview blocked until approval: requested path resolves through a symlink';
    }
    return 'Preview blocked until approval: requested path escapes the workspace';
}

function containsPath(root: string, path: string): boolean {
    const child = relative(root, path);
    return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

async function inspectLexicalPath(root: string, absolutePath: string): Promise<LexicalPathInspection> {
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
            if (error instanceof Error) return 'target_unreadable';
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
