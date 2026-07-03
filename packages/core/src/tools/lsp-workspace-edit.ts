// Clean-room reimplementation of LSP workspace-edit application.
// The tool-definition shapes and the rename workflow are informed by the
// oh-my-openagent lsp-core tool surface (clean-room: no source copied,
// reimplemented fresh). The diff-generation uses mission-control's existing
// DiffFile/DiffHunk protocol types, not the oh-my-openagent formatters.

import type { DiffFile, DiffHunk, DiffLine } from '@mission-control/protocol';
import type { LspPosition, LspRange, LspTextEdit, LspWorkspaceEdit } from './lsp-tool.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Flatten a `LspWorkspaceEdit` into per-file edit lists keyed by URI. Supports
 * both the `changes` map (`{ [uri]: TextEdit[] }`) and the `documentChanges`
 * array (`TextDocumentEdit[]`). `documentChanges` takes precedence when present.
 * CreateFile / RenameFile / DeleteFile operations in `documentChanges` are
 * ignored (rename-only scope for the MVP).
 */
export function collectWorkspaceEdits(edit: LspWorkspaceEdit | undefined): ReadonlyMap<string, readonly LspTextEdit[]> {
    const result = new Map<string, readonly LspTextEdit[]>();
    if (edit === undefined) return result;

    if (edit.documentChanges !== undefined) {
        for (const doc of edit.documentChanges) {
            const existing = result.get(doc.uri);
            result.set(doc.uri, existing !== undefined ? [...existing, ...doc.edits] : [...doc.edits]);
        }
        return result;
    }

    if (edit.changes !== undefined) {
        for (const [uri, edits] of Object.entries(edit.changes)) {
            if (edits === undefined) continue;
            const existing = result.get(uri);
            result.set(uri, existing !== undefined ? [...existing, ...edits] : [...edits]);
        }
    }

    return result;
}

export type AppliedFileEdit = {
    readonly uri: string;
    readonly filePath: string;
    readonly diff: DiffFile;
};

export type ApplyWorkspaceEditResult = {
    readonly applied: readonly AppliedFileEdit[];
    readonly fileCount: number;
    readonly editCount: number;
};

export type ApplyWorkspaceEditDeps = {
    /** Reads file content for a URI. Default reads from disk. */
    readonly readDocument?: (uri: string) => Promise<string>;
    /** Writes file content for a URI. Default writes to disk (creates parent dirs). */
    readonly writeDocument?: (uri: string, content: string) => Promise<void>;
};

/**
 * Apply a workspace edit: for each affected file, read the current content,
 * apply the text edits (sorted in reverse position order so earlier ranges are
 * not shifted by later ones), write the result, and produce a `DiffFile` for
 * event emission.
 *
 * Returns one `AppliedFileEdit` per modified file. Files that are read-only or
 * do not exist are skipped (the LSP server should not send edits for
 * non-existent files, but we are defensive).
 */
export async function applyLspWorkspaceEdit(
    edit: LspWorkspaceEdit | undefined,
    workspaceRoot: string,
    deps?: ApplyWorkspaceEditDeps,
): Promise<ApplyWorkspaceEditResult> {
    const readDocument = deps?.readDocument ?? defaultReadDocument;
    const writeDocument = deps?.writeDocument ?? defaultWriteDocument;
    const editsByUri = collectWorkspaceEdits(edit);

    const applied: AppliedFileEdit[] = [];
    for (const [uri, edits] of editsByUri) {
        if (edits.length === 0) continue;
        let content: string;
        try {
            content = await readDocument(uri);
        } catch {
            // File missing or unreadable: skip (defensive; server should not edit missing files).
            continue;
        }
        const { newContent, hunks } = applyEditsToContent(content, edits);
        if (hunks.length === 0) continue;
        await writeDocument(uri, newContent);
        const filePath = uriToPath(uri);
        applied.push({
            uri,
            filePath,
            diff: {
                filePath,
                changeKind: 'modified',
                hunks,
            },
        });
    }

    return {
        applied,
        fileCount: applied.length,
        editCount: editsByUri.size,
    };
}

/**
 * Apply text edits to a string. LSP ranges are character-level within lines,
 * so we operate on the raw string, not split lines. Edits are sorted by
 * position (descending) so applying from the end backwards keeps earlier
 * ranges stable. Returns the new content and a diff hunk per edit.
 */
function applyEditsToContent(
    content: string,
    edits: readonly LspTextEdit[],
): { readonly newContent: string; readonly hunks: DiffHunk[] } {
    const offsets = buildLineOffsets(content);
    const sorted = [...edits].sort((a, b) => comparePositionsDesc(a.range.start, b.range.start));

    let result = content;
    const hunks: DiffHunk[] = [];

    for (const edit of sorted) {
        const startOffset = positionToOffset(edit.range.start, offsets, result);
        const endOffset = positionToOffset(edit.range.end, offsets, result);
        if (startOffset > endOffset) continue;
        const oldSlice = result.slice(startOffset, endOffset);
        result = result.slice(0, startOffset) + edit.newText + result.slice(endOffset);

        const oldLines = oldSlice.split('\n');
        const newLines = edit.newText.split('\n');
        const diffLines = buildDiffLines(oldLines, newLines);
        if (diffLines.length === 0) continue;

        hunks.push({
            oldStart: edit.range.start.line + 1,
            oldLines: oldLines.length,
            newStart: edit.range.start.line + 1,
            newLines: newLines.length,
            lines: diffLines,
        });
    }

    return { newContent: result, hunks };
}

/** Build a lookup table mapping line number → byte offset in the content. */
function buildLineOffsets(content: string): number[] {
    const offsets = [0];
    for (let i = 0; i < content.length; i++) {
        if (content[i] === '\n') {
            offsets.push(i + 1);
        }
    }
    return offsets;
}

/** Convert an LSP position (line + character) to a string offset. */
function positionToOffset(
    pos: { readonly line: number; readonly character: number },
    offsets: readonly number[],
    content: string,
): number {
    const lineOffset = offsets[Math.min(pos.line, offsets.length - 1)] ?? 0;
    const clampedChar = Math.max(0, pos.character);
    return Math.min(lineOffset + clampedChar, content.length);
}

/**
 * Build the per-line diff (context / added / removed) between the old slice
 * and the replacement. A simple line-level diff: lines present in old but not
 * new are removed, lines in new but not old are added, common lines are context.
 */
function buildDiffLines(oldLines: readonly string[], newLines: readonly string[]): DiffLine[] {
    const result: DiffLine[] = [];
    const oldSet = new Set(oldLines);
    const newSet = new Set(newLines);

    for (const line of oldLines) {
        if (newSet.has(line) && !result.some((d) => d.kind === 'context' && d.content === line)) {
            result.push({ kind: 'context', content: line });
        } else {
            result.push({ kind: 'removed', content: line });
        }
    }
    for (const line of newLines) {
        if (!oldSet.has(line)) {
            result.push({ kind: 'added', content: line });
        }
    }
    return result;
}

function comparePositionsDesc(a: LspPosition, b: LspPosition): number {
    if (a.line !== b.line) return b.line - a.line;
    return b.character - a.character;
}

function uriToPath(uri: string): string {
    if (uri.startsWith('file://')) {
        return decodeURIComponent(uri.slice('file://'.length));
    }
    return uri;
}

const defaultReadDocument = async (uri: string): Promise<string> => {
    const path = uri.startsWith('file://') ? decodeURIComponent(uri.slice('file://'.length)) : uri;
    return readFile(path, 'utf8');
};

const defaultWriteDocument = async (uri: string, content: string): Promise<void> => {
    const path = uri.startsWith('file://') ? decodeURIComponent(uri.slice('file://'.length)) : uri;
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content, 'utf8');
};
