/** @jsxImportSource @opentui/solid */

import { padEndToDisplayWidth, terminalDisplayWidth, truncateTerminalText } from '@mission-control/tui';
import { TextAttributes } from '@opentui/core';
import { createMemo, For, type JSX, Show } from 'solid-js';
import {
    createHistoryPickerView,
    type HistoryPickerEntry,
    type HistoryPickerState,
    type HistoryPickerVisibleRow,
} from '../state/history-picker-state';
import { OverlayFrame } from './OverlayFrame';
import { SELECTED_BG } from './overlay-theme';

export type HistoryPickerPanelProps = {
    readonly entries: readonly HistoryPickerEntry[];
    readonly pickerState: HistoryPickerState;
    readonly maxLines: number;
    readonly columns?: number;
    readonly nowMs?: number;
    readonly showFooter?: boolean;
};

const FOOTER = 'Up/Down navigate, Enter insert, Esc close';
const MIN_TIME_COLUMN_WIDTH = 14;
const MARKER_WIDTH = 2;
const COLUMN_GAP = 2;
const DEFAULT_COLUMNS = 80;

export type HistoryPickerLayoutLine = {
    readonly content: string;
    readonly time: string | undefined;
    readonly selected: boolean;
};

/**
 * Minimum display width for the time column across visible rows (at least 14).
 */
export function computeHistoryTimeColumnWidth(timeColumns: readonly string[]): number {
    if (timeColumns.length === 0) {
        return MIN_TIME_COLUMN_WIDTH;
    }
    let max = 0;
    for (const time of timeColumns) {
        const width = terminalDisplayWidth(time);
        if (width > max) {
            max = width;
        }
    }
    return Math.max(MIN_TIME_COLUMN_WIDTH, max);
}

/**
 * Content column width given total terminal columns and the reserved time column.
 * Leaves room for selection marker + gap + time column.
 */
export function computeHistoryContentColumnWidth(columns: number, timeColumnWidth: number): number {
    const usable = Math.max(1, columns - 1);
    const reserved = MARKER_WIDTH + COLUMN_GAP + timeColumnWidth;
    return Math.max(1, usable - reserved);
}

/**
 * Build display lines for one visible history row (2-column layout).
 * Time appears only on the first line; remaining preview lines pad under content.
 */
export function layoutHistoryPickerRow(
    row: HistoryPickerVisibleRow,
    contentWidth: number,
    timeColumnWidth: number,
): readonly HistoryPickerLayoutLine[] {
    const lines: HistoryPickerLayoutLine[] = [];
    const previewLines = row.previewLines.length > 0 ? row.previewLines : [''];
    for (let index = 0; index < previewLines.length; index += 1) {
        const raw = previewLines[index] ?? '';
        const marker = index === 0 ? (row.selected ? '> ' : '  ') : '  ';
        const truncated = truncateTerminalText(raw, contentWidth, '\u2026');
        const padded = padEndToDisplayWidth(truncated, contentWidth);
        const content = `${marker}${padded}`;
        const time =
            index === 0
                ? padEndToDisplayWidth(truncateTerminalText(row.timeColumn, timeColumnWidth, '\u2026'), timeColumnWidth)
                : undefined;
        lines.push({ content, time, selected: row.selected });
    }
    return lines;
}

export function HistoryPickerPanel(props: HistoryPickerPanelProps): JSX.Element {
    const open = (): boolean => props.pickerState.open && props.maxLines > 0;
    const view = createMemo(() => {
        const nowMs = props.nowMs ?? Date.now();
        return createHistoryPickerView(props.entries, props.pickerState, props.maxLines, nowMs);
    });
    const columns = (): number => props.columns ?? DEFAULT_COLUMNS;
    const showFooter = (): boolean => props.showFooter ?? true;
    const header = createMemo(() => {
        const current = view();
        if (current.empty || current.totalCount === 0) {
            return 'Prompt history';
        }
        return `Prompt history (${current.totalCount})`;
    });
    const timeColumnWidth = createMemo(() => {
        const current = view();
        if (current.empty) {
            return MIN_TIME_COLUMN_WIDTH;
        }
        return computeHistoryTimeColumnWidth(current.rows.map((row) => row.timeColumn));
    });
    const contentWidth = createMemo(() => computeHistoryContentColumnWidth(columns(), timeColumnWidth()));

    return (
        <Show when={open()}>
            <OverlayFrame variant="panel" title={header()} {...(showFooter() ? { footer: FOOTER } : {})}>
                <Show when={!view().empty} fallback={<text attributes={TextAttributes.DIM}> No prompt history</text>}>
                    <For each={view().empty ? [] : view().rows}>
                        {(row) => {
                            const lines = (): readonly HistoryPickerLayoutLine[] =>
                                layoutHistoryPickerRow(row, contentWidth(), timeColumnWidth());
                            return (
                                <box flexDirection="column">
                                    <For each={lines()}>
                                        {(line) => {
                                            const selectedBg = line.selected ? { bg: SELECTED_BG } : {};
                                            return (
                                                <box flexDirection="row" height={1}>
                                                    <text {...selectedBg}>{line.content}</text>
                                                    {line.time !== undefined ? (
                                                        <text attributes={TextAttributes.DIM} {...selectedBg}>
                                                            {`  ${line.time}`}
                                                        </text>
                                                    ) : null}
                                                </box>
                                            );
                                        }}
                                    </For>
                                </box>
                            );
                        }}
                    </For>
                </Show>
            </OverlayFrame>
        </Show>
    );
}
