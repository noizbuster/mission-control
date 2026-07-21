/** @jsxImportSource @opentui/solid */

import { For, type JSX, Show, createMemo } from 'solid-js';
import type { TranscriptPart } from '../state/transcript-part';
import {
    aggregateToolCallsForMessage,
    formatInlineSummary,
    type ToolCallAggregate,
} from '../state/tool-call-aggregation';
import {
    CHAT_ASSISTANT_PAD_LEFT,
    CHAT_ERROR,
    CHAT_PANEL_BG,
    CHAT_SUCCESS,
    CHAT_TEXT_MUTED,
    CHAT_USER_PAD_X,
} from './chat-theme';
import { LEFT_ACCENT_BORDER } from './overlay-theme';

export type AssistantMessageFooterProps = {
    readonly messageId: string;
    readonly parts: readonly TranscriptPart[];
    readonly expanded: boolean;
};

export type ColoredTextSegment = {
    readonly text: string;
    readonly color: string;
};

export type BreakdownRow = {
    readonly segments: readonly ColoredTextSegment[];
};

/**
 * Dual-color chip segments for Element B.
 * Failed count is CHAT_ERROR; surrounding tools/marker text stays muted.
 */
export function chipLabelSegments(agg: ToolCallAggregate, expanded: boolean): readonly ColoredTextSegment[] {
    const marker = expanded ? '-' : '+';
    if (agg.totalCount === 0 && agg.failedCount === 0) {
        return [];
    }
    if (agg.failedCount === 0) {
        return [{ text: `${agg.totalCount} tools · [${marker}]`, color: CHAT_TEXT_MUTED }];
    }
    if (agg.totalCount === 0) {
        return [
            { text: `${agg.failedCount} failed`, color: CHAT_ERROR },
            { text: ` · [${marker}]`, color: CHAT_TEXT_MUTED },
        ];
    }
    return [
        { text: `${agg.totalCount} tools · `, color: CHAT_TEXT_MUTED },
        { text: `${agg.failedCount} failed`, color: CHAT_ERROR },
        { text: ` · [${marker}]`, color: CHAT_TEXT_MUTED },
    ];
}

/**
 * Expanded breakdown rows with per-segment colors:
 * mutation +A SUCCESS / -R ERROR; exit 0 muted / nonzero ERROR; failed line ERROR.
 */
export function buildBreakdownRows(agg: ToolCallAggregate): readonly BreakdownRow[] {
    const rows: BreakdownRow[] = [];
    for (const [name, count] of agg.byToolName) {
        const segments: ColoredTextSegment[] = [
            { text: `${name}  ×${count}`, color: CHAT_TEXT_MUTED },
        ];
        const delta = agg.mutationDeltas.get(name);
        if (delta !== undefined && (delta.added !== 0 || delta.removed !== 0)) {
            segments.push({ text: ' (', color: CHAT_TEXT_MUTED });
            segments.push({ text: `+${delta.added}`, color: CHAT_SUCCESS });
            segments.push({ text: ' ', color: CHAT_TEXT_MUTED });
            segments.push({ text: `-${delta.removed}`, color: CHAT_ERROR });
            segments.push({ text: ')', color: CHAT_TEXT_MUTED });
        }
        const codes = agg.commandExitCodes.get(name);
        if (codes !== undefined && codes.length > 0) {
            segments.push({ text: ' (exit ', color: CHAT_TEXT_MUTED });
            for (let index = 0; index < codes.length; index += 1) {
                if (index > 0) {
                    segments.push({ text: '/', color: CHAT_TEXT_MUTED });
                }
                const code = codes[index];
                if (code === undefined) {
                    continue;
                }
                segments.push({
                    text: String(code),
                    color: code === 0 ? CHAT_TEXT_MUTED : CHAT_ERROR,
                });
            }
            segments.push({ text: ')', color: CHAT_TEXT_MUTED });
        }
        rows.push({ segments });
    }
    if (agg.failedCount > 0) {
        rows.push({
            segments: [{ text: `⚠ failed ×${agg.failedCount}`, color: CHAT_ERROR }],
        });
    }
    return rows;
}

export function shouldRenderAssistantMessageFooter(agg: ToolCallAggregate): boolean {
    return agg.totalCount > 0 || agg.failedCount > 0;
}

/**
 * Past-assistant footer: Element A (muted inline tool tally) + Element B (chip + optional breakdown).
 * Parent owns Ctrl+O and passes `expanded`; this component never handles the key itself.
 */
export function AssistantMessageFooter(props: AssistantMessageFooterProps): JSX.Element {
    const agg = createMemo(() => aggregateToolCallsForMessage(props.parts, props.messageId));
    const visible = createMemo(() => shouldRenderAssistantMessageFooter(agg()));
    const summary = createMemo(() => formatInlineSummary(agg()));
    const chipSegments = createMemo(() => chipLabelSegments(agg(), props.expanded));
    const breakdownRows = createMemo(() => buildBreakdownRows(agg()));

    return (
        <Show when={visible()}>
            <box flexDirection="column" paddingLeft={CHAT_ASSISTANT_PAD_LEFT} flexShrink={0}>
                <box flexDirection="row" justifyContent="flex-end" flexShrink={0}>
                    <Show when={summary().length > 0}>
                        <text selectable flexGrow={1} fg={CHAT_TEXT_MUTED}>
                            {summary()}
                        </text>
                    </Show>
                    <box flexDirection="row" flexShrink={0}>
                        <For each={chipSegments()}>
                            {(segment) => (
                                <text selectable fg={segment.color}>
                                    {segment.text}
                                </text>
                            )}
                        </For>
                    </box>
                </box>
                <Show when={props.expanded}>
                    <box
                        border={['left']}
                        customBorderChars={LEFT_ACCENT_BORDER}
                        borderColor={CHAT_PANEL_BG}
                        paddingLeft={CHAT_USER_PAD_X}
                        flexDirection="column"
                        flexShrink={0}
                    >
                        <For each={breakdownRows()}>
                            {(row) => (
                                <box flexDirection="row" flexShrink={0}>
                                    <For each={row.segments}>
                                        {(segment) => (
                                            <text selectable fg={segment.color}>
                                                {segment.text}
                                            </text>
                                        )}
                                    </For>
                                </box>
                            )}
                        </For>
                    </box>
                </Show>
            </box>
        </Show>
    );
}
