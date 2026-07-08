import { For, type JSX } from 'solid-js';
import type { DiffLine, DiffLineKind } from './render-diff.js';

export type DiffViewProps = {
    readonly lines: readonly DiffLine[];
};

/**
 * Per-kind opentui `<text>` style. `added` -> green, `removed` -> red,
 * `context` -> dim, `hunk`/`meta` -> cyan. Exposed for unit testing.
 */
export type DiffKindStyle = {
    readonly fg?: string;
    readonly dim?: boolean;
};

const KIND_STYLE: Readonly<Record<DiffLineKind, DiffKindStyle>> = {
    added: { fg: '#00ff00' },
    removed: { fg: '#ff0000' },
    context: { dim: true },
    hunk: { fg: '#00ffff' },
    meta: { fg: '#00ffff' },
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
 * between/around them carry `inverse: false`. opentui styling is per element, so
 * the `DiffView` renders each span as its own `<text>` element.
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

function DiffRow({ line }: { readonly line: DiffLine }): JSX.Element {
    const style = kindStyle(line.kind);
    const spans = splitLineSpans(line);
    const fg = style.fg;
    const rowStyle = {
        ...(fg !== undefined ? { fg } : {}),
        ...(style.dim === true ? { dim: true } : {}),
    };
    return (
        <box flexDirection="row">
            <For each={spans}>
                {(span) => (
                    <text {...rowStyle} {...(span.inverse ? { inverse: true } : {})}>
                        {span.text}
                    </text>
                )}
            </For>
        </box>
    );
}

export function DiffView({ lines }: DiffViewProps): JSX.Element {
    return (
        <box flexDirection="column">
            <For each={lines}>{(line) => <DiffRow line={line} />}</For>
        </box>
    );
}
