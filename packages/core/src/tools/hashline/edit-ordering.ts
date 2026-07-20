// clean-room reimplementation of hashline edit-by-hash
// (algorithm inspired by upstream agent harness hashline-core and oh-my-pi hashline;
// reimplemented from scratch in fresh mission-control code, no source
// expression copied). License classification is recorded in
// .omo/evidence/license-matrix.md.

import type { LineRef } from './validation';
import { parseLineRef } from './validation';

// The three operations every edit must use. `replace` swaps a single line or a
// pos..end range; `append` inserts after an anchor (or at EOF when no anchor);
// `prepend` inserts before an anchor (or at BOF when no anchor). `lines: null`
// or `lines: []` paired with `replace` deletes the targeted line(s).
export interface ReplaceEdit {
    readonly op: 'replace';
    readonly pos: string;
    readonly end?: string;
    readonly lines: readonly string[] | string | null;
}

export interface AppendEdit {
    readonly op: 'append';
    readonly pos?: string;
    readonly lines: readonly string[] | string;
}

export interface PrependEdit {
    readonly op: 'prepend';
    readonly pos?: string;
    readonly lines: readonly string[] | string;
}

export type HashlineEdit = ReplaceEdit | AppendEdit | PrependEdit;

const OP_PRECEDENCE: Readonly<Record<string, number>> = { replace: 0, append: 1, prepend: 2 };

/**
 * Highest 1-based line an edit touches. Edits are applied bottom-up (descending
 * line number) so an earlier edit cannot shift the anchors a later edit still
 * references. Unanchored append/prepend sink to the bottom of the ordering.
 */
export function editAnchorLine(edit: HashlineEdit): number {
    switch (edit.op) {
        case 'replace':
            return parseLineRef(edit.end ?? edit.pos).line;
        case 'append':
        case 'prepend':
            return edit.pos !== undefined ? parseLineRef(edit.pos).line : Number.NEGATIVE_INFINITY;
    }
}

/** Collect every LINE#ID reference an edit set cites (for up-front validation). */
export function collectLineRefs(edits: readonly HashlineEdit[]): readonly string[] {
    const refs: string[] = [];
    for (const edit of edits) {
        switch (edit.op) {
            case 'replace':
                refs.push(edit.pos);
                if (edit.end !== undefined) {
                    refs.push(edit.end);
                }
                break;
            case 'append':
            case 'prepend':
                if (edit.pos !== undefined) {
                    refs.push(edit.pos);
                }
                break;
        }
    }
    return refs;
}

/** Bottom-up comparator: higher line first; ties break by op precedence. */
export function compareEditsBottomUp(left: HashlineEdit, right: HashlineEdit): number {
    const leftLine = editAnchorLine(left);
    const rightLine = editAnchorLine(right);
    if (leftLine !== rightLine) {
        return rightLine - leftLine;
    }
    return (OP_PRECEDENCE[left.op] ?? 3) - (OP_PRECEDENCE[right.op] ?? 3);
}

export interface ResolvedRange {
    readonly start: number;
    readonly end: number;
    readonly index: number;
}

/** Reject overlapping `replace` ranges that would corrupt each other's spans. */
export function detectOverlappingRanges(edits: readonly HashlineEdit[]): string | null {
    const ranges: ResolvedRange[] = [];
    for (let index = 0; index < edits.length; index += 1) {
        const edit = edits[index];
        if (edit === undefined || edit.op !== 'replace' || edit.end === undefined) {
            continue;
        }
        const start = parseLineRef(edit.pos).line;
        const end = parseLineRef(edit.end).line;
        ranges.push({ start, end, index });
    }
    if (ranges.length < 2) {
        return null;
    }
    ranges.sort((left, right) => left.start - right.start || left.end - right.end);
    for (let index = 1; index < ranges.length; index += 1) {
        const previous = ranges[index - 1];
        const current = ranges[index];
        if (previous === undefined || current === undefined) {
            continue;
        }
        if (current.start <= previous.end) {
            return (
                `Overlapping range edits detected: edit ${previous.index + 1} ` +
                `(lines ${previous.start}-${previous.end}) overlaps with edit ${current.index + 1} ` +
                `(lines ${current.start}-${current.end}). Use pos-only replace for single-line edits.`
            );
        }
    }
    return null;
}

export type { LineRef };
