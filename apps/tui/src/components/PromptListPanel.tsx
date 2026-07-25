/** @jsxImportSource @opentui/solid */

import { padEndToDisplayWidth, terminalDisplayWidth, truncateTerminalText } from '@mission-control/tui';
import { TextAttributes } from '@opentui/core';
import { createMemo, For, Show, type JSX } from 'solid-js';
import { OverlayFrame } from './OverlayFrame';
import { SELECTED_BG } from './overlay-theme';

export type PromptListColumn = {
    readonly id: string;
    readonly width: 'fit' | 'fill';
    readonly minWidth?: number;
    readonly maxWidth?: number;
    readonly dim?: boolean;
};

export type PromptListCell = {
    readonly lines: readonly string[];
    readonly dim?: boolean;
};

export type PromptListRow = {
    readonly id: string;
    readonly cells: readonly PromptListCell[];
    readonly selected: boolean;
};

export type PromptListControls = {
    readonly filterable: boolean;
    readonly selectable: boolean;
    readonly acceptKeys: readonly ('tab' | 'enter')[];
    readonly acceptVerb: string;
    readonly dismissible: boolean;
};

export type PromptListPanelProps = {
    readonly title: string;
    readonly rows: readonly PromptListRow[];
    readonly columns: readonly PromptListColumn[];
    readonly viewportColumns: number;
    readonly emptyMessage: string;
    readonly controls: PromptListControls;
    readonly showFooter?: boolean;
};

export type PromptListLayoutCell = {
    readonly columnId: string;
    readonly text: string;
    readonly dim: boolean;
};

export type PromptListLayoutLine = {
    readonly rowId: string;
    readonly rowIndex: number;
    readonly lineIndex: number;
    readonly continuation: boolean;
    readonly selected: boolean;
    readonly marker: string;
    readonly cells: readonly PromptListLayoutCell[];
    readonly columnGap: string;
    readonly trailingPadding: string;
};

export type PromptListLayout = {
    readonly viewportWidth: number;
    readonly markerWidth: number;
    readonly columnWidths: readonly number[];
    readonly lines: readonly PromptListLayoutLine[];
};

type PromptListColumnSizing = {
    readonly minWidth: number;
    readonly maxWidth: number;
    readonly fitWidth: number;
};

const COLUMN_GAP_WIDTH = 2;
const SELECTION_MARKER_WIDTH = 2;
const TRUNCATION_MARKER = '\u2026';

/**
 * Creates the single, deterministic instruction line used by prompt-adjacent
 * list panels. Domains retain ownership of the actual key handling.
 */
export function formatPromptListControlsFooter(controls: PromptListControls): string {
    const parts: string[] = [];
    if (controls.filterable) {
        parts.push('Type to filter');
    }
    if (controls.selectable) {
        parts.push('Up/Down navigate');
    }

    const acceptVerb = controls.acceptVerb.trim();
    const acceptKeys = formatAcceptKeys(controls.acceptKeys);
    if (acceptKeys !== '' && acceptVerb !== '') {
        parts.push(`${acceptKeys} ${acceptVerb}`);
    }
    if (controls.dismissible) {
        parts.push('Esc close');
    }
    return parts.join(', ');
}

/**
 * Fits visible rows into terminal columns without mixing terminal-cell widths
 * with JavaScript string lengths. The caller owns filtering, viewporting, and
 * selection state; this only prepares presentational lines.
 */
export function layoutPromptListRows(
    rows: readonly PromptListRow[],
    columns: readonly PromptListColumn[],
    viewportColumns: number,
    selectable: boolean = true,
): PromptListLayout {
    const viewportWidth = normalizeViewportColumns(viewportColumns);
    const markerWidth = selectable ? Math.min(SELECTION_MARKER_WIDTH, viewportWidth) : 0;
    const availableWidth = Math.max(0, viewportWidth - markerWidth);
    const gapWidth = resolveColumnGapWidth(columns.length, availableWidth);
    const columnBudget = Math.max(0, availableWidth - gapWidth * Math.max(0, columns.length - 1));
    const sizing = columns.map((column, index) => resolveColumnSizing(column, widestCellLine(rows, index)));
    const columnWidths = allocateColumnWidths(sizing, columns, columnBudget);
    const columnGap = ' '.repeat(gapWidth);
    const lines: PromptListLayoutLine[] = [];

    for (let rowIndex = 0; rowIndex < rows.length; rowIndex += 1) {
        const row = rows[rowIndex];
        if (row === undefined) continue;
        const lineCount = lineCountForRow(row, columns.length);
        const selected = selectable && row.selected;

        for (let lineIndex = 0; lineIndex < lineCount; lineIndex += 1) {
            const marker = selectionMarker(selected, lineIndex, markerWidth);
            const cells: PromptListLayoutCell[] = [];
            for (let columnIndex = 0; columnIndex < columns.length; columnIndex += 1) {
                const column = columns[columnIndex];
                if (column === undefined) continue;
                const cell = row.cells[columnIndex];
                const width = columnWidths[columnIndex] ?? 0;
                const rawText = cell?.lines[lineIndex] ?? '';
                cells.push({
                    columnId: column.id,
                    text: fitTextToWidth(rawText, width),
                    dim: column.dim === true || cell?.dim === true,
                });
            }

            const usedWidth =
                terminalDisplayWidth(marker) +
                cells.reduce((total, cell) => total + terminalDisplayWidth(cell.text), 0) +
                gapWidth * Math.max(0, cells.length - 1);
            lines.push({
                rowId: row.id,
                rowIndex,
                lineIndex,
                continuation: lineIndex > 0,
                selected,
                marker,
                cells,
                columnGap,
                trailingPadding: ' '.repeat(Math.max(0, viewportWidth - usedWidth)),
            });
        }
    }

    return { viewportWidth, markerWidth, columnWidths, lines };
}

export function PromptListPanel(props: PromptListPanelProps): JSX.Element {
    const layout = createMemo(() =>
        layoutPromptListRows(props.rows, props.columns, props.viewportColumns, props.controls.selectable),
    );
    const footer = createMemo(() => formatPromptListControlsFooter(props.controls));
    const emptyMessage = createMemo(() => fitTextToWidth(props.emptyMessage, layout().viewportWidth));

    return (
        <OverlayFrame
            variant="panel"
            title={props.title}
            {...(props.showFooter !== false && footer() !== '' ? { footer: footer() } : {})}
        >
            <Show
                when={layout().lines.length > 0}
                fallback={
                    <box height={1}>
                        <text attributes={TextAttributes.DIM}>{emptyMessage()}</text>
                    </box>
                }
            >
                <For each={layout().lines}>
                    {(line) => {
                        const selectedBackground = line.selected ? { bg: SELECTED_BG } : {};
                        return (
                            <box flexDirection="row" height={1}>
                                {line.marker !== '' ? <text {...selectedBackground}>{line.marker}</text> : null}
                                <For each={line.cells}>
                                    {(cell, index) => (
                                        <>
                                            {index() > 0 && line.columnGap !== '' ? (
                                                <text {...selectedBackground}>{line.columnGap}</text>
                                            ) : null}
                                            <text
                                                {...selectedBackground}
                                                {...(cell.dim ? { attributes: TextAttributes.DIM } : {})}
                                            >
                                                {cell.text}
                                            </text>
                                        </>
                                    )}
                                </For>
                                {line.trailingPadding !== '' ? (
                                    <text {...selectedBackground}>{line.trailingPadding}</text>
                                ) : null}
                            </box>
                        );
                    }}
                </For>
            </Show>
        </OverlayFrame>
    );
}

function formatAcceptKeys(acceptKeys: PromptListControls['acceptKeys']): string {
    const labels: string[] = [];
    if (acceptKeys.includes('tab')) {
        labels.push('Tab');
    }
    if (acceptKeys.includes('enter')) {
        labels.push('Enter');
    }
    return labels.join('/');
}

function normalizeViewportColumns(columns: number): number {
    if (!Number.isFinite(columns)) return 1;
    return Math.max(1, Math.trunc(columns));
}

function resolveColumnGapWidth(columnCount: number, availableWidth: number): number {
    if (columnCount < 2) return 0;
    const roomAfterMinimumCells = Math.max(0, availableWidth - columnCount);
    return Math.min(COLUMN_GAP_WIDTH, Math.floor(roomAfterMinimumCells / (columnCount - 1)));
}

function resolveColumnSizing(column: PromptListColumn, contentWidth: number): PromptListColumnSizing {
    const maxWidth = normalizeMaximumWidth(column.maxWidth);
    const requestedMinimum = normalizeMinimumWidth(column.minWidth);
    const minWidth = Math.min(requestedMinimum, maxWidth);
    const fitWidth = column.width === 'fit' ? Math.min(maxWidth, Math.max(minWidth, contentWidth)) : minWidth;
    return { minWidth, maxWidth, fitWidth };
}

function normalizeMinimumWidth(width: number | undefined): number {
    if (width === undefined || !Number.isFinite(width)) return 1;
    return Math.max(0, Math.trunc(width));
}

function normalizeMaximumWidth(width: number | undefined): number {
    if (width === undefined || !Number.isFinite(width)) return Number.MAX_SAFE_INTEGER;
    return Math.max(0, Math.trunc(width));
}


function widestCellLine(rows: readonly PromptListRow[], columnIndex: number): number {
    let widest = 0;
    for (const row of rows) {
        const cell = row.cells[columnIndex];
        if (cell === undefined) continue;
        for (const line of cell.lines) {
            widest = Math.max(widest, terminalDisplayWidth(line));
        }
    }
    return widest;
}

function allocateColumnWidths(
    sizing: readonly PromptListColumnSizing[],
    columns: readonly PromptListColumn[],
    budget: number,
): readonly number[] {
    const widths = Array.from({ length: columns.length }, () => 0);
    const allIndexes = columns.map((_, index) => index);
    let remaining = distributeWidth(widths, sizing, allIndexes, budget, (size) => size.minWidth);
    const fitIndexes = columns.flatMap((column, index) => (column.width === 'fit' ? [index] : []));
    remaining = distributeWidth(widths, sizing, fitIndexes, remaining, (size) => size.fitWidth);
    const fillIndexes = columns.flatMap((column, index) => (column.width === 'fill' ? [index] : []));
    distributeWidth(widths, sizing, fillIndexes, remaining, (size) => size.maxWidth);
    return widths;
}

function distributeWidth(
    widths: number[],
    sizing: readonly PromptListColumnSizing[],
    indexes: readonly number[],
    budget: number,
    limitFor: (size: PromptListColumnSizing) => number,
): number {
    let remaining = budget;
    while (remaining > 0) {
        let activeCount = 0;
        for (const index of indexes) {
            const size = sizing[index];
            if (size !== undefined && (widths[index] ?? 0) < limitFor(size)) {
                activeCount += 1;
            }
        }
        if (activeCount === 0) break;

        const share = Math.max(1, Math.floor(remaining / activeCount));
        let consumed = 0;
        for (const index of indexes) {
            if (remaining === 0) break;
            const size = sizing[index];
            if (size === undefined) continue;
            const currentWidth = widths[index] ?? 0;
            const addition = Math.min(share, limitFor(size) - currentWidth, remaining);
            if (addition <= 0) continue;
            widths[index] = currentWidth + addition;
            remaining -= addition;
            consumed += addition;
        }
        if (consumed === 0) break;
    }
    return remaining;
}

function lineCountForRow(row: PromptListRow, columnCount: number): number {
    let lineCount = 1;
    for (let columnIndex = 0; columnIndex < columnCount; columnIndex += 1) {
        const cell = row.cells[columnIndex];
        if (cell !== undefined) {
            lineCount = Math.max(lineCount, cell.lines.length);
        }
    }
    return lineCount;
}

function selectionMarker(selected: boolean, lineIndex: number, markerWidth: number): string {
    if (markerWidth === 0) return '';
    if (markerWidth === 1) return selected && lineIndex === 0 ? '>' : ' ';
    return selected && lineIndex === 0 ? '> ' : '  ';
}

function fitTextToWidth(text: string, width: number): string {
    if (width <= 0) return '';
    return padEndToDisplayWidth(truncateTerminalText(text, width, TRUNCATION_MARKER), width);
}
