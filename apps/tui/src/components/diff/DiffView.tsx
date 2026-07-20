/** @jsxImportSource @opentui/solid */

import { pathToFiletype } from '@opentui/core';
import { useTerminalDimensions } from '@opentui/solid';
import { For, type JSX, Show } from 'solid-js';
import { CHAT_DIFF_ADDED, CHAT_DIFF_REMOVED, CHAT_SECONDARY, CHAT_TEXT_MUTED } from '../chat-theme';
import { getSharedSyntaxStyle } from '../markdown/shared-syntax-style';
import { DIFF_THEME } from './diff-theme';
import type { DiffLine, DiffLineKind } from './render-diff';

export type DiffViewProps = {
    readonly diff?: string;
    readonly filetype?: string;
    readonly filePath?: string;
    readonly lines?: readonly DiffLine[];
};

export type DiffKindStyle = {
    readonly fg?: string;
    readonly dim?: boolean;
};

const KIND_STYLE: Readonly<Record<DiffLineKind, DiffKindStyle>> = {
    added: { fg: CHAT_DIFF_ADDED },
    removed: { fg: CHAT_DIFF_REMOVED },
    context: { fg: CHAT_TEXT_MUTED, dim: true },
    hunk: { fg: CHAT_SECONDARY },
    meta: { fg: CHAT_SECONDARY },
};

export function kindStyle(kind: DiffLineKind): DiffKindStyle {
    return KIND_STYLE[kind];
}

export type TextSpan = {
    readonly text: string;
    readonly inverse: boolean;
};

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

function LegacyDiffRow(props: { readonly line: DiffLine }): JSX.Element {
    const style = kindStyle(props.line.kind);
    const spans = splitLineSpans(props.line);
    const fg = style.fg;
    const rowStyle = {
        ...(fg !== undefined ? { fg } : {}),
        ...(style.dim === true ? { dim: true } : {}),
    };
    return (
        <box flexDirection="row">
            <For each={spans}>
                {(span) => (
                    <text selectable {...rowStyle} {...(span.inverse ? { inverse: true } : {})}>
                        {span.text}
                    </text>
                )}
            </For>
        </box>
    );
}

function resolveFiletype(props: DiffViewProps): string | undefined {
    if (props.filetype !== undefined && props.filetype.length > 0) return props.filetype;
    if (props.filePath !== undefined && props.filePath.length > 0) {
        return pathToFiletype(props.filePath);
    }
    return undefined;
}

function resolveDiffText(props: DiffViewProps): string | undefined {
    if (props.diff !== undefined) return props.diff;
    if (props.lines !== undefined && props.lines.length > 0) {
        return props.lines.map((line) => line.text).join('\n');
    }
    return undefined;
}

export function DiffView(props: DiffViewProps): JSX.Element {
    const dimensions = useTerminalDimensions();
    const diffText = () => resolveDiffText(props);
    const filetype = () => resolveFiletype(props);
    const view = () => (dimensions().width > 120 ? 'split' : 'unified');

    return (
        <Show
            when={diffText()}
            fallback={
                <box flexDirection="column">
                    <For each={props.lines ?? []}>{(line) => <LegacyDiffRow line={line} />}</For>
                </box>
            }
        >
            {(text) => {
                const ft = filetype();
                return (
                    <diff
                        diff={text()}
                        view={view()}
                        {...(ft !== undefined ? { filetype: ft } : {})}
                        syntaxStyle={getSharedSyntaxStyle()}
                        showLineNumbers={true}
                        width="100%"
                        wrapMode="word"
                        fg={DIFF_THEME.fg}
                        addedBg={DIFF_THEME.addedBg}
                        removedBg={DIFF_THEME.removedBg}
                        contextBg={DIFF_THEME.contextBg}
                        addedSignColor={DIFF_THEME.addedSignColor}
                        removedSignColor={DIFF_THEME.removedSignColor}
                        lineNumberFg={DIFF_THEME.lineNumberFg}
                        lineNumberBg={DIFF_THEME.lineNumberBg}
                        addedLineNumberBg={DIFF_THEME.addedLineNumberBg}
                        removedLineNumberBg={DIFF_THEME.removedLineNumberBg}
                    />
                );
            }}
        </Show>
    );
}
