import { filePatchFailure } from './file-patch-errors.js';
import type { ParsedPatchFile } from './file-patch-parser.js';

export function applyParsedPatch(file: ParsedPatchFile, original: string): string {
    const originalLines = splitLines(original);
    const output: string[] = [];
    let cursor = 0;
    for (const hunk of file.hunks) {
        const hunkStart = hunk.oldStart === 0 ? 0 : hunk.oldStart - 1;
        if (hunkStart < cursor || hunkStart > originalLines.length) {
            throw applyFailure(file, `hunk starts outside target at line ${hunk.oldStart}`);
        }
        output.push(...originalLines.slice(cursor, hunkStart));
        cursor = hunkStart;
        for (const line of hunk.lines) {
            switch (line.kind) {
                case 'context':
                    expectLine(file, originalLines, cursor, line.content);
                    output.push(line.content);
                    cursor += 1;
                    break;
                case 'removed':
                    expectLine(file, originalLines, cursor, line.content);
                    cursor += 1;
                    break;
                case 'added':
                    output.push(line.content);
                    break;
            }
        }
    }
    output.push(...originalLines.slice(cursor));
    return joinLines(output);
}

function splitLines(content: string): readonly string[] {
    if (content.length === 0) {
        return [];
    }
    const trimmed = content.endsWith('\n') ? content.slice(0, -1) : content;
    return trimmed.length === 0 ? [] : trimmed.split('\n');
}

function joinLines(lines: readonly string[]): string {
    return lines.length === 0 ? '' : `${lines.join('\n')}\n`;
}

function expectLine(file: ParsedPatchFile, lines: readonly string[], index: number, expected: string): void {
    const actual = lines[index];
    if (actual !== expected) {
        throw applyFailure(file, `context mismatch at line ${index + 1}`);
    }
}

function applyFailure(file: ParsedPatchFile, message: string): Error {
    const path = file.newPath ?? file.oldPath ?? 'unknown';
    return filePatchFailure('patch_apply_failed', `${path}: ${message}`);
}
