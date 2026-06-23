import { diffWords } from 'diff';

export type DiffLineKind = 'context' | 'added' | 'removed' | 'hunk' | 'meta';

/**
 * Half-open character-offset range into a `DiffLine.text` that should render
 * inverse (the changed-token highlight). `end` is exclusive.
 */
export type InvertedSegment = {
    readonly start: number;
    readonly end: number;
};

export type DiffLine = {
    readonly kind: DiffLineKind;
    /** Tab-expanded content (prefix marker stripped for added/removed/context). */
    readonly text: string;
    readonly invertedSegments?: ReadonlyArray<InvertedSegment>;
};

const TAB_REPLACEMENT = '   ';

type ClassifiedLine = {
    readonly kind: DiffLineKind;
    readonly content: string;
};

type SegmentedLine = {
    readonly text: string;
    readonly segments: ReadonlyArray<InvertedSegment>;
};

/**
 * Classify a single unified-diff line into its kind and the content to render.
 *
 * mctrl's `renderFileEditPreview` emits `-<line>` / `+<line>` (no line numbers,
 * no space after the marker), standard `--- a/<path>` / `+++ b/<path>` / `Target:`
 * meta lines, and `@@` hunk headers. Context lines start with a single space.
 */
function classifyLine(line: string): ClassifiedLine {
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('Target: ')) {
        return { kind: 'meta', content: line };
    }
    if (line.startsWith('@@')) {
        return { kind: 'hunk', content: line };
    }
    if (line.startsWith('-')) {
        return { kind: 'removed', content: line.slice(1) };
    }
    if (line.startsWith('+')) {
        return { kind: 'added', content: line.slice(1) };
    }
    if (line.startsWith(' ')) {
        return { kind: 'context', content: line.slice(1) };
    }
    return { kind: 'context', content: line };
}

function replaceTabs(text: string): string {
    return text.replaceAll('\t', TAB_REPLACEMENT);
}

function leadingWhitespace(text: string): string {
    const match = text.match(/^\s*/);
    return match === null ? '' : (match[0] ?? '');
}

/**
 * Port of pi's `renderIntraLineDiff`. Runs `diffWords` over a single
 * removed+added content pair and records the changed tokens as inverse
 * character-offset segments on each line. The first removed/added part has its
 * leading whitespace stripped from the inverse range so indentation is never
 * highlighted. Common parts land on both lines without an inverse segment.
 */
function computeIntraLine(
    oldContent: string,
    newContent: string,
): {
    readonly removed: SegmentedLine;
    readonly added: SegmentedLine;
} {
    const parts = diffWords(oldContent, newContent);
    let removedText = '';
    let addedText = '';
    const removedSegments: InvertedSegment[] = [];
    const addedSegments: InvertedSegment[] = [];
    let isFirstRemoved = true;
    let isFirstAdded = true;

    for (const part of parts) {
        if (part.removed) {
            let value = part.value;
            if (isFirstRemoved) {
                const ws = leadingWhitespace(value);
                value = value.slice(ws.length);
                removedText += ws;
                isFirstRemoved = false;
            }
            if (value.length > 0) {
                const start = removedText.length;
                removedText += value;
                removedSegments.push({ start, end: removedText.length });
            }
        } else if (part.added) {
            let value = part.value;
            if (isFirstAdded) {
                const ws = leadingWhitespace(value);
                value = value.slice(ws.length);
                addedText += ws;
                isFirstAdded = false;
            }
            if (value.length > 0) {
                const start = addedText.length;
                addedText += value;
                addedSegments.push({ start, end: addedText.length });
            }
        } else {
            removedText += part.value;
            addedText += part.value;
        }
    }

    return {
        removed: { text: removedText, segments: removedSegments },
        added: { text: addedText, segments: addedSegments },
    };
}

function toDiffLine(kind: DiffLineKind, segmented: SegmentedLine): DiffLine {
    if (segmented.segments.length === 0) {
        return { kind, text: segmented.text };
    }
    return { kind, text: segmented.text, invertedSegments: segmented.segments };
}

/**
 * Parse unified-diff text into structured `DiffLine[]` with intra-line
 * word-level highlighting. Only a single removed line immediately followed by a
 * single added line gets word-level inverse segments; multi-line blocks render
 * as-is. Never throws; unrecognised lines fall back to `context`.
 */
export function renderDiff(diffText: string): DiffLine[] {
    if (diffText.length === 0) {
        return [];
    }

    const lines = diffText.split('\n');
    const result: DiffLine[] = [];
    let i = 0;

    while (i < lines.length) {
        const current = classifyLine(lines[i] ?? '');

        if (current.kind !== 'removed') {
            result.push({ kind: current.kind, text: replaceTabs(current.content) });
            i++;
            continue;
        }

        // Collect consecutive removed lines.
        const removedContents: string[] = [];
        while (i < lines.length) {
            const c = classifyLine(lines[i] ?? '');
            if (c.kind !== 'removed') break;
            removedContents.push(replaceTabs(c.content));
            i++;
        }

        // Collect consecutive added lines immediately following.
        const addedContents: string[] = [];
        while (i < lines.length) {
            const c = classifyLine(lines[i] ?? '');
            if (c.kind !== 'added') break;
            addedContents.push(replaceTabs(c.content));
            i++;
        }

        if (removedContents.length === 1 && addedContents.length === 1) {
            const { removed, added } = computeIntraLine(removedContents[0] ?? '', addedContents[0] ?? '');
            result.push(toDiffLine('removed', removed));
            result.push(toDiffLine('added', added));
        } else {
            for (const content of removedContents) {
                result.push({ kind: 'removed', text: content });
            }
            for (const content of addedContents) {
                result.push({ kind: 'added', text: content });
            }
        }
    }

    return result;
}
