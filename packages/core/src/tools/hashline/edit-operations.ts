// clean-room reimplementation of hashline edit-by-hash
// (algorithm inspired by oh-my-openagent hashline-core and oh-my-pi hashline;
// reimplemented from scratch in fresh mission-control code, no source
// expression copied). License classification is recorded in
// .omo/evidence/license-matrix.md.

import { collectLineRefs, compareEditsBottomUp, detectOverlappingRanges, type HashlineEdit } from './edit-ordering';
import { parseLineRef, validateLineRefs } from './validation';

export type { HashlineEdit } from './edit-ordering';

// Raw edit shape coming from the tool schema: every field is unknown until
// normalized. Named properties (not an index signature) so dot access compiles
// under noPropertyAccessFromIndexSignature.
type RawEditFields = {
    readonly op?: unknown;
    readonly pos?: unknown;
    readonly end?: unknown;
    readonly lines?: unknown;
};

// --- input normalization ----------------------------------------------------

/** Accept a raw edit (string `op`, array/string/null `lines`) and normalize it. */
export function normalizeEdit(raw: RawEditFields): HashlineEdit {
    const op = typeof raw.op === 'string' ? raw.op.toLowerCase() : '';
    switch (op) {
        case 'replace': {
            if (typeof raw.pos !== 'string' || raw.pos.length === 0) {
                throw new Error('replace edit requires a non-empty `pos` LINE#ID anchor.');
            }
            const lines = normalizeLines(raw.lines, 'replace');
            return {
                op: 'replace',
                pos: raw.pos,
                ...(typeof raw.end === 'string' && raw.end.length > 0 ? { end: raw.end } : {}),
                lines,
            };
        }
        case 'append':
        case 'prepend': {
            const normalized = normalizeLines(raw.lines, op);
            // normalizeLines only returns null for `replace` (it throws for the
            // other ops), so narrow here to satisfy the append/prepend lines type.
            if (normalized === null) {
                throw new Error(`\`lines: null\` is not valid for ${op}.`);
            }
            const edit: { op: typeof op; pos?: string; lines: string | readonly string[] } = { op, lines: normalized };
            if (typeof raw.pos === 'string' && raw.pos.length > 0) {
                edit.pos = raw.pos;
            }
            return edit;
        }
        default:
            throw new Error(
                `Unknown edit op "${String(raw.op)}". Use op/pos/end/lines with one of: replace, append, prepend.`,
            );
    }
}

export function normalizeEdits(raw: readonly { readonly [key: string]: unknown }[]): readonly HashlineEdit[] {
    return raw.map((entry) => normalizeEdit(entry));
}

/**
 * Coerce the `lines` field into a string, string[], or null. A string is kept
 * as-is (split lazily at apply time). `null` or `[]` is allowed only for
 * `replace` (meaning delete the targeted line/range); for append and prepend it
 * is a schema error because inserting nothing is meaningless.
 */
function normalizeLines(value: unknown, op: string): readonly string[] | string | null {
    if (value === null) {
        if (op !== 'replace') {
            throw new Error(`\`lines: null\` is not valid for ${op}; it is only valid for replace (delete).`);
        }
        return null;
    }
    if (typeof value === 'string') {
        return value;
    }
    if (Array.isArray(value)) {
        const asStrings = value.map((entry) => (typeof entry === 'string' ? entry : String(entry)));
        if (asStrings.length === 0 && op === 'replace') {
            return null;
        }
        if (asStrings.length === 0) {
            throw new Error(`\`lines: []\` is not valid for ${op}; provide at least one line.`);
        }
        return asStrings;
    }
    throw new Error(`\`lines\` must be a string, a string array, or null (delete) - got ${typeof value}.`);
}

function toLineArray(value: readonly string[] | string | null): readonly string[] {
    if (value === null) {
        return [];
    }
    if (typeof value === 'string') {
        return value.length === 0 ? [] : value.split('\n');
    }
    return value;
}

// --- deduplication ----------------------------------------------------------

function canonicalAnchor(anchor: string | undefined): string {
    return anchor ?? '';
}

function canonicalLines(value: readonly string[] | string | null): string {
    return toLineArray(value).join('\n');
}

function dedupeKey(edit: HashlineEdit): string {
    switch (edit.op) {
        case 'replace':
            return `replace|${canonicalAnchor(edit.pos)}|${canonicalAnchor(edit.end)}|${canonicalLines(edit.lines)}`;
        case 'append':
            return `append|${canonicalAnchor(edit.pos)}|${canonicalLines(edit.lines)}`;
        case 'prepend':
            return `prepend|${canonicalAnchor(edit.pos)}|${canonicalLines(edit.lines)}`;
    }
}

export interface DedupeResult {
    readonly edits: readonly HashlineEdit[];
    readonly deduplicatedEdits: number;
}

export function dedupeEdits(edits: readonly HashlineEdit[]): DedupeResult {
    const seen = new Set<string>();
    const kept: HashlineEdit[] = [];
    let removed = 0;
    for (const edit of edits) {
        const key = dedupeKey(edit);
        if (seen.has(key)) {
            removed += 1;
            continue;
        }
        seen.add(key);
        kept.push(edit);
    }
    return { edits: kept, deduplicatedEdits: removed };
}

// --- autocorrect ------------------------------------------------------------

function leadingIndent(line: string): string {
    const match = line.match(/^\s*/);
    return match === null ? '' : (match[0] ?? '');
}

function restoreIndent(original: string, replacement: string): string {
    if (replacement.length === 0) {
        return replacement;
    }
    if (leadingIndent(replacement).length > 0) {
        return replacement;
    }
    const indent = leadingIndent(original);
    if (indent.length === 0) {
        return replacement;
    }
    if (original.trim() === replacement.trim()) {
        return replacement;
    }
    return `${indent}${replacement}`;
}

const CONTINUATION_SUFFIX = /(?:&&|\|\||\?\?|\?|:|=|,|\+|-|\*|\/|\.|\()\s*$/u;

function stripTrailingContinuation(text: string): string {
    return text.replace(CONTINUATION_SUFFIX, '');
}

/**
 * When a model collapses several original lines into one replacement, try to
 * re-expand it back to the original count by splitting on the original parts or
 * on semicolons. Recovers the most common whitespace-merge failure mode.
 */
function maybeExpandMerge(originalLines: readonly string[], replacement: readonly string[]): readonly string[] {
    if (replacement.length !== 1 || originalLines.length <= 1) {
        return replacement;
    }
    const merged = replacement[0] ?? '';
    const parts = originalLines.map((line) => line.trim()).filter((line) => line.length > 0);
    if (parts.length !== originalLines.length) {
        return replacement;
    }
    const expanded = splitByOrderedParts(merged, parts);
    if (expanded !== null && expanded.length === originalLines.length) {
        return expanded;
    }
    const bySemicolon = merged
        .split(/;\s+/)
        .map((segment, index, array) => (index < array.length - 1 && !segment.endsWith(';') ? `${segment};` : segment))
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);
    if (bySemicolon.length === originalLines.length) {
        return bySemicolon;
    }
    return replacement;
}

function splitByOrderedParts(merged: string, parts: readonly string[]): string[] | null {
    const indices: number[] = [];
    let offset = 0;
    for (const part of parts) {
        let index = merged.indexOf(part, offset);
        let matchLength = part.length;
        if (index === -1) {
            const stripped = stripTrailingContinuation(part);
            if (stripped !== part) {
                index = merged.indexOf(stripped, offset);
                if (index !== -1) {
                    matchLength = stripped.length;
                }
            }
        }
        if (index === -1) {
            return null;
        }
        indices.push(index);
        offset = index + matchLength;
    }
    const out: string[] = [];
    for (let index = 0; index < indices.length; index += 1) {
        const start = indices[index] ?? 0;
        const end = index + 1 < indices.length ? (indices[index + 1] ?? merged.length) : merged.length;
        const candidate = merged.slice(start, end).trim();
        if (candidate.length === 0) {
            return null;
        }
        out.push(candidate);
    }
    return out;
}

function restorePairedIndent(originalLines: readonly string[], replacement: readonly string[]): readonly string[] {
    if (originalLines.length !== replacement.length) {
        return replacement;
    }
    return replacement.map((line, index) => restoreIndent(originalLines[index] ?? '', line));
}

/** Autocorrect a replacement span: expand accidental merges, restore indent. */
export function autocorrectReplacementLines(
    originalLines: readonly string[],
    replacement: readonly string[],
): readonly string[] {
    const expanded = maybeExpandMerge(originalLines, replacement);
    return restorePairedIndent(originalLines, expanded);
}

// --- apply primitives -------------------------------------------------------

function linesEqual(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) {
        return false;
    }
    for (let index = 0; index < left.length; index += 1) {
        if (left[index] !== right[index]) {
            return false;
        }
    }
    return true;
}

function applySetLine(lines: readonly string[], anchor: string, replacement: readonly string[]): readonly string[] {
    const { line } = parseLineRef(anchor);
    const original = lines[line - 1] ?? '';
    const corrected = autocorrectReplacementLines([original], replacement);
    const restored = corrected.map((entry, index) => (index === 0 ? restoreIndent(original, entry) : entry));
    const result = [...lines];
    result.splice(line - 1, 1, ...restored);
    return result;
}

function applyReplaceRange(
    lines: readonly string[],
    startAnchor: string,
    endAnchor: string,
    replacement: readonly string[],
): readonly string[] {
    const { line: startLine } = parseLineRef(startAnchor);
    const { line: endLine } = parseLineRef(endAnchor);
    if (startLine > endLine) {
        throw new Error(`Invalid range: start line ${startLine} cannot be greater than end line ${endLine}.`);
    }
    const originalRange = lines.slice(startLine - 1, endLine);
    const corrected = autocorrectReplacementLines(originalRange, replacement);
    const restored = corrected.map((entry, index) =>
        index === 0 ? restoreIndent(lines[startLine - 1] ?? '', entry) : entry,
    );
    const result = [...lines];
    result.splice(startLine - 1, endLine - startLine + 1, ...restored);
    return result;
}

function applyInsertAfter(lines: readonly string[], anchor: string, insertion: readonly string[]): readonly string[] {
    const { line } = parseLineRef(anchor);
    if (insertion.length === 0) {
        throw new Error(`append (anchored) requires non-empty text for ${anchor}.`);
    }
    const result = [...lines];
    result.splice(line, 0, ...insertion);
    return result;
}

function applyInsertBefore(lines: readonly string[], anchor: string, insertion: readonly string[]): readonly string[] {
    const { line } = parseLineRef(anchor);
    if (insertion.length === 0) {
        throw new Error(`prepend (anchored) requires non-empty text for ${anchor}.`);
    }
    const result = [...lines];
    result.splice(line - 1, 0, ...insertion);
    return result;
}

function applyAppendEnd(lines: readonly string[], insertion: readonly string[]): readonly string[] {
    if (insertion.length === 0) {
        throw new Error('append requires non-empty text.');
    }
    if (lines.length === 0 || (lines.length === 1 && lines[0] === '')) {
        return [...insertion];
    }
    // A file ending in a newline splits to a trailing '' element. Insert before
    // it so the appended content forms a new terminated line rather than a
    // blank gap followed by the new text.
    const result = [...lines];
    const insertAt = result[result.length - 1] === '' ? result.length - 1 : result.length;
    result.splice(insertAt, 0, ...insertion);
    return result;
}

function applyPrependStart(lines: readonly string[], insertion: readonly string[]): readonly string[] {
    if (insertion.length === 0) {
        throw new Error('prepend requires non-empty text.');
    }
    if (lines.length === 1 && lines[0] === '') {
        return [...insertion];
    }
    return [...insertion, ...lines];
}

// --- top-level apply --------------------------------------------------------

export interface HashlineApplyReport {
    readonly content: string;
    readonly noopEdits: number;
    readonly deduplicatedEdits: number;
    readonly appliedEdits: number;
}

export function applyHashlineEditsWithReport(content: string, edits: readonly HashlineEdit[]): HashlineApplyReport {
    if (edits.length === 0) {
        return { content, noopEdits: 0, deduplicatedEdits: 0, appliedEdits: 0 };
    }
    const deduped = dedupeEdits(edits);
    const sorted = [...deduped.edits].sort(compareEditsBottomUp);

    let lines: readonly string[] = content.length === 0 ? [] : content.split('\n');
    validateLineRefs(lines, collectLineRefs(sorted));

    const overlapError = detectOverlappingRanges(sorted);
    if (overlapError !== null) {
        throw new Error(overlapError);
    }

    let noopEdits = 0;
    let appliedEdits = 0;
    for (const edit of sorted) {
        const next = applyOne(lines, edit);
        if (linesEqual(next, lines)) {
            noopEdits += 1;
            continue;
        }
        appliedEdits += 1;
        lines = next;
    }
    return {
        content: lines.join('\n'),
        noopEdits,
        deduplicatedEdits: deduped.deduplicatedEdits,
        appliedEdits,
    };
}

function applyOne(lines: readonly string[], edit: HashlineEdit): readonly string[] {
    switch (edit.op) {
        case 'replace': {
            const replacement = toLineArray(edit.lines);
            return edit.end !== undefined
                ? applyReplaceRange(lines, edit.pos, edit.end, replacement)
                : applySetLine(lines, edit.pos, replacement);
        }
        case 'append': {
            const insertion = toLineArray(edit.lines);
            return edit.pos !== undefined
                ? applyInsertAfter(lines, edit.pos, insertion)
                : applyAppendEnd(lines, insertion);
        }
        case 'prepend': {
            const insertion = toLineArray(edit.lines);
            return edit.pos !== undefined
                ? applyInsertBefore(lines, edit.pos, insertion)
                : applyPrependStart(lines, insertion);
        }
    }
}

export function applyHashlineEdits(content: string, edits: readonly HashlineEdit[]): string {
    return applyHashlineEditsWithReport(content, edits).content;
}
