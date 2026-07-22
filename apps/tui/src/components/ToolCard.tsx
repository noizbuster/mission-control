/** @jsxImportSource @opentui/solid */

import { For, type JSX, Show } from 'solid-js';
import type { TranscriptPartStatus } from '../state/transcript-part';
import {
    buildInlineToolLabel,
    CHAT_ERROR,
    CHAT_SECONDARY,
    CHAT_SUCCESS,
    CHAT_TEXT,
    CHAT_TEXT_MUTED,
    CHAT_TOOL_ICON_WIDTH,
    CHAT_WARNING,
    toolIconForTitle,
} from './chat-theme';
import { DiffView } from './diff/DiffView';

export type ToolCardProps = {
    readonly lines: readonly string[];
    readonly title?: string;
    readonly expanded: boolean;
    readonly status?: TranscriptPartStatus;
    readonly bodyMode?: ToolCardBodyMode;
};

export type ToolCardBodyMode = 'auto' | 'plain';

export type ToolStatusPresentation = {
    readonly label: string | undefined;
    readonly glyph: string | undefined;
    readonly color: string;
};

export function toolStatusPresentation(status: TranscriptPartStatus | undefined): ToolStatusPresentation {
    switch (status) {
        case undefined:
            return { label: undefined, glyph: undefined, color: CHAT_TEXT_MUTED };
        case 'pending':
        case 'running':
        case 'streaming':
            return { label: undefined, glyph: '~', color: CHAT_WARNING };
        case 'completed':
            return { label: undefined, glyph: '+', color: CHAT_SUCCESS };
        case 'failed':
        case 'denied':
            return { label: undefined, glyph: '!', color: CHAT_ERROR };
        case 'cancelled':
        case 'interrupted':
            return { label: undefined, glyph: 'x', color: CHAT_WARNING };
        case 'background':
            return { label: undefined, glyph: '>', color: CHAT_SECONDARY };
        case 'informational':
        case 'historical':
            return { label: undefined, glyph: 'i', color: CHAT_TEXT_MUTED };
        default:
            return assertNever(status, 'tool status');
    }
}

/**
 * Detect whether the block contains unified-diff content. Returns true when any
 * line starts with a leading `+`, `-` (covers `+line`/`-line`/`+++ `/`--- `), or
 * `@@` hunk marker. Prose lines like `Target: foo` or `Edit preview for ...` do
 * not start with those markers and therefore return false.
 */
export function hasDiffContent(lines: readonly string[]): boolean {
    return lines.some((line) => line.startsWith('+') || line.startsWith('-') || line.startsWith('@@'));
}

export function shouldRenderToolBodyAsDiff(lines: readonly string[], mode: ToolCardBodyMode): boolean {
    switch (mode) {
        case 'auto':
            return hasDiffContent(lines);
        case 'plain':
            return false;
        default:
            return assertNever(mode, 'tool body mode');
    }
}

/**
 * Build the header label text. OpenCode-style: bare title, with no `>` prefix
 * or statistics, so collapsed and expanded rows match.
 *
 * Kept as `buildHeaderLabel` for existing unit-test imports.
 */
export function buildHeaderLabel(title: string | undefined): string {
    return buildInlineToolLabel(title);
}

/**
 * OpenCode-style tool row:
 * - Collapsed / non-diff: inline icon + muted title (InlineTool)
 * - Expanded with body: left-accent BlockTool panel + body (diff or prose)
 */
export function ToolCard(props: ToolCardProps): JSX.Element {
    const title = () => props.title;
    const lines = () => props.lines;
    const expanded = () => props.expanded;
    const bodyMode = () => props.bodyMode ?? 'auto';
    const status = () => toolStatusPresentation(props.status);
    const header = () => {
        const base = buildHeaderLabel(title());
        const glyph = status().glyph;
        return glyph === undefined ? base : `${base} [${glyph}]`;
    };
    const icon = () => toolIconForTitle(title());
    const showBlock = () => expanded() && lines().length > 0;

    return (
        <Show
            when={showBlock()}
            fallback={
                <box flexDirection="row" flexShrink={0}>
                    <text width={CHAT_TOOL_ICON_WIDTH} fg={status().color}>
                        {icon()}
                    </text>
                    <text selectable flexGrow={1} fg={status().color}>
                        {header()}
                    </text>
                </box>
            }
        >
            <box flexDirection="column" flexShrink={0}>
                <box flexDirection="row">
                    <text width={CHAT_TOOL_ICON_WIDTH} fg={status().color}>
                        {icon()}
                    </text>
                    <text selectable flexGrow={1} fg={status().color}>
                        {header()}
                    </text>
                </box>
                {shouldRenderToolBodyAsDiff(lines(), bodyMode()) ? (
                    <DiffView diff={lines().join('\n')} />
                ) : (
                    <For each={lines()}>
                        {(line) => (
                            <text selectable fg={CHAT_TEXT}>
                                {line}
                            </text>
                        )}
                    </For>
                )}
            </box>
        </Show>
    );
}

function assertNever(value: never, label: string): never {
    throw new Error(`Unexpected ${label}: ${value}`);
}
