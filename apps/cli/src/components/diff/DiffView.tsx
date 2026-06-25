/** @jsxImportSource @opentui/react */
import type React from 'react';
import { toOpenTuiColor } from '../../platform/opentui-types.js';
import type { DiffLine, DiffLineKind } from './render-diff.js';

export type DiffViewProps = {
    readonly lines: readonly DiffLine[];
};

/**
 * Per-kind Ink `<Text>` style. `added` -> green, `removed` -> red,
 * `context` -> dim, `hunk`/`meta` -> cyan. Exposed for unit testing.
 */
export type DiffKindStyle = {
    readonly color?: string;
    readonly dimColor?: boolean;
};

const KIND_STYLE: Readonly<Record<DiffLineKind, DiffKindStyle>> = {
    added: { color: 'green' },
    removed: { color: 'red' },
    context: { dimColor: true },
    hunk: { color: 'cyan' },
    meta: { color: 'cyan' },
};

export function kindStyle(kind: DiffLineKind): DiffKindStyle {
    return KIND_STYLE[kind];
}

/**
 * A contiguous run of text that shares a single styling decision: either inside
 * an `invertedSegment` (rendered inverse) or outside (rendered with the row's
 * kind style). Exposed for unit testing.
 */
export type TextSpan = {
    readonly text: string;
    readonly inverse: boolean;
};

/**
 * Split a `DiffLine.text` into ordered spans at every `invertedSegment`
 * boundary. Spans covering an inverted range carry `inverse: true`; the gaps
 * between/around them carry `inverse: false`. Ink has no mid-string styling, so
 * the `DiffView` renders each span as its own `<Text>` element.
 */
export function splitLineSpans(line: DiffLine): readonly TextSpan[] {
    const segments = line.invertedSegments;
    if (segments === undefined || segments.length === 0) {
        return [{ text: line.text, inverse: false }];
    }

    const spans: TextSpan[] = [];
    let cursor = 0;
    for (const seg of segments) {
        if (seg.start > cursor) {
            spans.push({ text: line.text.slice(cursor, seg.start), inverse: false });
        }
        spans.push({ text: line.text.slice(seg.start, seg.end), inverse: true });
        cursor = seg.end;
    }
    if (cursor < line.text.length) {
        spans.push({ text: line.text.slice(cursor), inverse: false });
    }
    return spans;
}

function DiffRow({ line, index }: { readonly line: DiffLine; readonly index: number }): React.ReactNode {
    const style = kindStyle(line.kind);
    const spans = splitLineSpans(line);
    const fg = style.color !== undefined ? toOpenTuiColor(style.color) : undefined;
    const rowStyle = {
        ...(fg !== undefined ? { fg } : {}),
        ...(style.dimColor === true ? { dim: true } : {}),
    };
    return (
        <box flexDirection="row">
            {spans.map((span, segIndex) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: index is stable per (line, segment)
                <text key={`seg-${index}-${segIndex}`} {...rowStyle} {...(span.inverse ? { inverse: true } : {})}>
                    {span.text}
                </text>
            ))}
        </box>
    );
}

export function DiffView({ lines }: DiffViewProps): React.ReactNode {
    return (
        <box flexDirection="column">
            {lines.map((line, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: line order is stable for a given input
                <DiffRow key={`diff-${index}`} line={line} index={index} />
            ))}
        </box>
    );
}
