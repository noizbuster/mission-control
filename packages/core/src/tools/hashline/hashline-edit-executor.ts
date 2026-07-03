// clean-room reimplementation of hashline edit-by-hash
// (algorithm inspired by oh-my-openagent hashline-core and oh-my-pi hashline;
// reimplemented from scratch in fresh mission-control code, no source
// expression copied). License classification is recorded in
// .omo/evidence/license-matrix.md.

import { applyHashlineEditsWithReport, type HashlineEdit, normalizeEdits } from './edit-operations.js';

export interface RawHashlineEdit {
    readonly [key: string]: unknown;
}

export interface HashlineEditOutcome {
    /** Resolved (normalized) edits that were actually applied. */
    readonly edits: readonly HashlineEdit[];
    /** File content before the apply. */
    readonly beforeContent: string;
    /** File content after the apply. */
    readonly afterContent: string;
    readonly noopEdits: number;
    readonly deduplicatedEdits: number;
    readonly appliedEdits: number;
    /** 1-based first line that differs between before and after (undefined when identical). */
    readonly firstChangedLine: number | undefined;
    readonly additions: number;
    readonly deletions: number;
    /** True when the apply did not change the content at all. */
    readonly unchanged: boolean;
}

/**
 * Pure executor: normalize raw edits, validate LINE#ID anchors against the
 * current content, and apply them bottom-up. Throws {@link HashlineMismatchError}
 * (re-exported from validation) when a referenced line no longer matches its
 * stored CID - the stale-anchor guard. Performs no file I/O.
 */
export function executeHashlineEdits(content: string, rawEdits: readonly RawHashlineEdit[]): HashlineEditOutcome {
    if (rawEdits.length === 0) {
        throw new Error('hashline_edit requires a non-empty `edits` array (or set `delete: true` to remove the file).');
    }
    const edits = normalizeEdits(rawEdits);
    const report = applyHashlineEditsWithReport(content, edits);
    const beforeLines = content.length === 0 ? [] : content.split('\n');
    const afterLines = report.content.length === 0 ? [] : report.content.split('\n');
    return {
        edits,
        beforeContent: content,
        afterContent: report.content,
        noopEdits: report.noopEdits,
        deduplicatedEdits: report.deduplicatedEdits,
        appliedEdits: report.appliedEdits,
        firstChangedLine: firstDifferingLine(beforeLines, afterLines),
        additions: Math.max(0, afterLines.length - countCommon(beforeLines, afterLines)),
        deletions: Math.max(0, beforeLines.length - countCommon(beforeLines, afterLines)),
        unchanged: report.content === content,
    };
}

function firstDifferingLine(before: readonly string[], after: readonly string[]): number | undefined {
    const max = Math.max(before.length, after.length);
    for (let index = 0; index < max; index += 1) {
        if ((before[index] ?? '') !== (after[index] ?? '')) {
            return index + 1;
        }
    }
    return undefined;
}

// A conservative common-line estimate: the smaller line count minus the number
// of positions where the two arrays already agree. This is intentionally simple
// (a true LCS is unnecessary for the diff summary surfaced to the model).
function countCommon(before: readonly string[], after: readonly string[]): number {
    const bound = Math.min(before.length, after.length);
    let common = 0;
    for (let index = 0; index < bound; index += 1) {
        if (before[index] === after[index]) {
            common += 1;
        }
    }
    return common;
}
