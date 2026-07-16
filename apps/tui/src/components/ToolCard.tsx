/** @jsxImportSource @opentui/solid */

import { For, type JSX, Show } from 'solid-js';
import {
    CHAT_PANEL_BG,
    CHAT_TEXT,
    CHAT_TEXT_MUTED,
    CHAT_TOOL_ICON_WIDTH,
    buildInlineToolLabel,
    toolIconForTitle,
} from './chat-theme';
import { DiffView } from './diff/DiffView';
import { renderDiff } from './diff/render-diff';
import { LEFT_ACCENT_BORDER } from './overlay-theme';

export type ToolCardProps = {
    readonly lines: readonly string[];
    readonly title?: string;
    readonly expanded: boolean;
};

/**
 * Detect whether the block contains unified-diff content. Returns true when any
 * line starts with a leading `+`, `-` (covers `+line`/`-line`/`+++ `/`--- `), or
 * `@@` hunk marker. Prose lines like `Target: foo` or `Edit preview for ...` do
 * not start with those markers and therefore return false.
 */
export function hasDiffContent(lines: readonly string[]): boolean {
    return lines.some((line) => line.startsWith('+') || line.startsWith('-') || line.startsWith('@@'));
}

/**
 * Build the header label text. OpenCode-style: plain title, with a
 * `(N lines)` hint when collapsed. The leading `>` prefix is gone so the
 * transcript matches ref/opencode InlineTool rows.
 *
 * Kept as `buildHeaderLabel` for existing unit-test imports.
 */
export function buildHeaderLabel(title: string | undefined, lineCount: number, expanded: boolean): string {
    return buildInlineToolLabel(title, lineCount, expanded);
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
    const header = () => buildHeaderLabel(title(), lines().length, expanded());
    const icon = () => toolIconForTitle(title());
    const showBlock = () => expanded() && lines().length > 0;

    return (
        <Show
            when={showBlock()}
            fallback={
                <box paddingLeft={3} flexDirection="row" flexShrink={0}>
                    <text width={CHAT_TOOL_ICON_WIDTH} fg={CHAT_TEXT_MUTED}>
                        {icon()}
                    </text>
                    <text flexGrow={1} fg={CHAT_TEXT_MUTED}>
                        {header()}
                    </text>
                </box>
            }
        >
            <box
                border={['left']}
                customBorderChars={LEFT_ACCENT_BORDER}
                borderColor={CHAT_PANEL_BG}
                paddingTop={1}
                paddingBottom={1}
                paddingLeft={2}
                marginTop={0}
                backgroundColor={CHAT_PANEL_BG}
                flexDirection="column"
                flexShrink={0}
                gap={1}
            >
                <box flexDirection="row" paddingLeft={3}>
                    <text width={CHAT_TOOL_ICON_WIDTH} fg={CHAT_TEXT_MUTED}>
                        {icon()}
                    </text>
                    <text flexGrow={1} fg={CHAT_TEXT_MUTED}>
                        {header()}
                    </text>
                </box>
                {hasDiffContent(lines()) ? (
                    <DiffView lines={renderDiff(lines().join('\n'))} />
                ) : (
                    <For each={lines()}>{(line) => <text fg={CHAT_TEXT}>{line}</text>}</For>
                )}
            </box>
        </Show>
    );
}
