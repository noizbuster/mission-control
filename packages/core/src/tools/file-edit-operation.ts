import type { DiffFile, DiffLine } from '@mission-control/protocol';
import type { FileEditInput } from './file-edit-schemas.js';
import { filePatchFailure } from './file-patch-errors.js';

type MatchRange = { readonly start: number; readonly end: number };

export type PreparedExactEdit = {
    readonly updatedContent: string;
    readonly occurrencesReplaced: number;
    readonly diffFiles: readonly DiffFile[];
};

export function prepareExactEdit(
    input: FileEditInput,
    relativePath: string,
    originalContent: string,
): PreparedExactEdit {
    const matches = findExactMatches(originalContent, input.oldText);
    const selectedMatches = selectMatches(matches, input, relativePath);
    const updatedContent = replaceMatches(originalContent, input.oldText, input.newText, selectedMatches);
    return {
        updatedContent,
        occurrencesReplaced: selectedMatches.length,
        diffFiles: [createDiffFile(relativePath, originalContent, updatedContent, selectedMatches, input)],
    };
}

function findExactMatches(content: string, oldText: string): readonly MatchRange[] {
    const matches: MatchRange[] = [];
    let searchStart = 0;
    while (searchStart <= content.length - oldText.length) {
        const start = content.indexOf(oldText, searchStart);
        if (start === -1) {
            break;
        }
        matches.push({ start, end: start + oldText.length });
        searchStart = start + oldText.length;
    }
    return matches;
}

function selectMatches(
    matches: readonly MatchRange[],
    input: FileEditInput,
    relativePath: string,
): readonly MatchRange[] {
    if (matches.length === 0) {
        throw filePatchFailure('edit_not_found', `exact text not found: ${relativePath}`);
    }
    if (input.replaceAll === true) {
        return matches;
    }
    if (input.occurrence !== undefined) {
        const match = matches[input.occurrence - 1];
        if (match === undefined) {
            throw filePatchFailure('edit_not_found', `occurrence ${input.occurrence} not found: ${relativePath}`);
        }
        return [match];
    }
    if (matches.length > 1) {
        throw filePatchFailure(
            'edit_not_unique',
            `multiple exact matches found in ${relativePath}; specify occurrence or replaceAll`,
        );
    }
    return [matches[0] as MatchRange];
}

function replaceMatches(content: string, _oldText: string, newText: string, matches: readonly MatchRange[]): string {
    let cursor = 0;
    let output = '';
    for (const match of matches) {
        output += content.slice(cursor, match.start);
        output += newText;
        cursor = match.end;
    }
    output += content.slice(cursor);
    return output;
}

function createDiffFile(
    relativePath: string,
    originalContent: string,
    updatedContent: string,
    matches: readonly MatchRange[],
    input: FileEditInput,
): DiffFile {
    const blocks = mergeAffectedLineBlocks(originalContent, matches);
    const hunks = blocks.map((block) => {
        const newBlockStart = mapOldOffsetToNewOffset(block.start, matches, input.oldText.length, input.newText.length);
        const newBlockEnd = mapOldOffsetToNewOffset(block.end, matches, input.oldText.length, input.newText.length);
        const oldBlockText = originalContent.slice(block.start, block.end);
        const newBlockText = updatedContent.slice(newBlockStart, newBlockEnd);
        return {
            oldStart: lineNumberAtOffset(originalContent, block.start),
            oldLines: countLogicalLines(oldBlockText),
            newStart: lineNumberAtOffset(updatedContent, newBlockStart),
            newLines: countLogicalLines(newBlockText),
            lines: [...toDiffLines('removed', oldBlockText), ...toDiffLines('added', newBlockText)],
        };
    });
    return {
        filePath: relativePath,
        changeKind: 'modified',
        hunks,
    };
}

function mergeAffectedLineBlocks(content: string, matches: readonly MatchRange[]): readonly MatchRange[] {
    const blocks = matches.map((match) => ({
        start: lineStartOffset(content, match.start),
        end: lineEndOffset(content, match.end),
    }));
    const merged: MatchRange[] = [];
    for (const block of blocks) {
        const current = merged.at(-1);
        if (current === undefined || block.start > current.end) {
            merged.push(block);
            continue;
        }
        merged[merged.length - 1] = { start: current.start, end: Math.max(current.end, block.end) };
    }
    return merged;
}

function lineStartOffset(content: string, offset: number): number {
    const previousNewline = content.lastIndexOf('\n', Math.max(0, offset - 1));
    return previousNewline === -1 ? 0 : previousNewline + 1;
}

function lineEndOffset(content: string, offset: number): number {
    const nextNewline = content.indexOf('\n', offset);
    return nextNewline === -1 ? content.length : nextNewline + 1;
}

function mapOldOffsetToNewOffset(
    offset: number,
    matches: readonly MatchRange[],
    oldLength: number,
    newLength: number,
): number {
    let delta = 0;
    for (const match of matches) {
        if (match.end > offset) {
            break;
        }
        delta += newLength - oldLength;
    }
    return offset + delta;
}

function lineNumberAtOffset(content: string, offset: number): number {
    let line = 1;
    for (let index = 0; index < offset; index += 1) {
        if (content[index] === '\n') {
            line += 1;
        }
    }
    return line;
}

function countLogicalLines(text: string): number {
    if (text.length === 0) {
        return 0;
    }
    return text.endsWith('\n') ? text.slice(0, -1).split('\n').length : text.split('\n').length;
}

function toDiffLines(kind: DiffLine['kind'], text: string): readonly DiffLine[] {
    if (text.length === 0) {
        return [];
    }
    const normalized = text.endsWith('\n') ? text.slice(0, -1) : text;
    return normalized.split('\n').map((content) => ({ kind, content }));
}
