import type { DiffFile, DiffLine } from '@mission-control/protocol';
import { filePatchFailure } from './file-patch-errors.js';

export type ParsedPatchFile = {
    readonly oldPath?: string;
    readonly newPath?: string;
    readonly changeKind: DiffFile['changeKind'];
    readonly hunks: readonly ParsedPatchHunk[];
};

export type ParsedPatchHunk = {
    readonly oldStart: number;
    readonly oldLines: number;
    readonly newStart: number;
    readonly newLines: number;
    readonly lines: readonly DiffLine[];
};

export function parseUnifiedPatch(patch: string): readonly ParsedPatchFile[] {
    const lines = patch.split(/\r?\n/);
    const files: ParsedPatchFile[] = [];
    let index = 0;
    while (index < lines.length) {
        const line = lines[index];
        if (line === undefined || line.length === 0) {
            index += 1;
            continue;
        }
        if (!line.startsWith('diff --git ')) {
            throw filePatchFailure('patch_parse_failed', `expected diff header at line ${index + 1}`);
        }
        const parsed = parseFile(lines, index);
        files.push(parsed.file);
        index = parsed.nextIndex;
    }
    if (files.length === 0) {
        throw filePatchFailure('patch_parse_failed', 'patch contains no file diffs');
    }
    return files;
}

export function toDiffFiles(files: readonly ParsedPatchFile[]): readonly DiffFile[] {
    return files.map((file) => ({
        filePath: targetPath(file),
        changeKind: file.changeKind,
        ...(file.oldPath !== undefined && file.oldPath !== file.newPath ? { oldFilePath: file.oldPath } : {}),
        hunks: file.hunks.map((hunk) => ({
            oldStart: hunk.oldStart === 0 ? 1 : hunk.oldStart,
            oldLines: hunk.oldLines,
            newStart: hunk.newStart === 0 ? 1 : hunk.newStart,
            newLines: hunk.newLines,
            lines: [...hunk.lines],
        })),
    }));
}

export function targetPath(file: ParsedPatchFile): string {
    const path = file.newPath ?? file.oldPath;
    if (path === undefined) {
        throw filePatchFailure('patch_parse_failed', 'file diff has no target path');
    }
    return path;
}

function parseFile(
    lines: readonly string[],
    startIndex: number,
): { readonly file: ParsedPatchFile; readonly nextIndex: number } {
    let index = startIndex + 1;
    const oldPathLine = lines[index];
    const newPathLine = lines[index + 1];
    if (oldPathLine === undefined || newPathLine === undefined) {
        throw filePatchFailure('patch_parse_failed', `missing file paths after line ${startIndex + 1}`);
    }
    const oldPath = parsePathLine(oldPathLine, '---');
    const newPath = parsePathLine(newPathLine, '+++');
    index += 2;

    const hunks: ParsedPatchHunk[] = [];
    while (index < lines.length) {
        const line = lines[index];
        if (line === undefined || line.startsWith('diff --git ')) {
            break;
        }
        if (line.length === 0) {
            index += 1;
            continue;
        }
        if (!line.startsWith('@@ ')) {
            throw filePatchFailure('patch_parse_failed', `expected hunk header at line ${index + 1}`);
        }
        const parsed = parseHunk(lines, index);
        hunks.push(parsed.hunk);
        index = parsed.nextIndex;
    }
    if (hunks.length === 0) {
        throw filePatchFailure('patch_parse_failed', `file diff has no hunks: ${newPath ?? oldPath ?? 'unknown'}`);
    }
    return {
        file: {
            ...(oldPath !== undefined ? { oldPath } : {}),
            ...(newPath !== undefined ? { newPath } : {}),
            changeKind: changeKindFor(oldPath, newPath),
            hunks,
        },
        nextIndex: index,
    };
}

function parsePathLine(line: string, prefix: '---' | '+++'): string | undefined {
    if (!line.startsWith(`${prefix} `)) {
        throw filePatchFailure('patch_parse_failed', `expected ${prefix} path line`);
    }
    const rawPath = line.slice(4).split('\t')[0] ?? '';
    if (rawPath === '/dev/null') {
        return undefined;
    }
    const path = rawPath.startsWith('a/') || rawPath.startsWith('b/') ? rawPath.slice(2) : rawPath;
    if (path.length === 0 || path.includes('\0')) {
        throw filePatchFailure('patch_parse_failed', 'patch path is empty or contains NUL');
    }
    return path;
}

function parseHunk(
    lines: readonly string[],
    startIndex: number,
): { readonly hunk: ParsedPatchHunk; readonly nextIndex: number } {
    const header = lines[startIndex] ?? '';
    const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header);
    if (match === null) {
        throw filePatchFailure('patch_parse_failed', `malformed hunk header at line ${startIndex + 1}`);
    }
    const oldStart = Number.parseInt(match[1] ?? '0', 10);
    const oldLines = Number.parseInt(match[2] ?? '1', 10);
    const newStart = Number.parseInt(match[3] ?? '0', 10);
    const newLines = Number.parseInt(match[4] ?? '1', 10);
    const hunkLines: DiffLine[] = [];
    let index = startIndex + 1;
    while (index < lines.length) {
        const line = lines[index];
        if (line === undefined || line.length === 0 || line.startsWith('diff --git ') || line.startsWith('@@ ')) {
            break;
        }
        if (line.startsWith('\\ No newline at end of file')) {
            index += 1;
            continue;
        }
        hunkLines.push(parseDiffLine(line, index));
        index += 1;
    }
    if (hunkLines.length === 0) {
        throw filePatchFailure('patch_parse_failed', `empty hunk at line ${startIndex + 1}`);
    }
    return { hunk: { oldStart, oldLines, newStart, newLines, lines: hunkLines }, nextIndex: index };
}

function parseDiffLine(line: string, index: number): DiffLine {
    const marker = line[0];
    const content = line.slice(1);
    switch (marker) {
        case ' ':
            return { kind: 'context', content };
        case '+':
            return { kind: 'added', content };
        case '-':
            return { kind: 'removed', content };
        default:
            throw filePatchFailure('patch_parse_failed', `invalid diff line marker at line ${index + 1}`);
    }
}

function changeKindFor(oldPath: string | undefined, newPath: string | undefined): DiffFile['changeKind'] {
    if (oldPath === undefined && newPath !== undefined) {
        return 'added';
    }
    if (oldPath !== undefined && newPath === undefined) {
        return 'deleted';
    }
    if (oldPath !== undefined && newPath !== undefined && oldPath !== newPath) {
        return 'renamed';
    }
    return 'modified';
}
