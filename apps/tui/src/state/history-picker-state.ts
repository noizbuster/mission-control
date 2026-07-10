/**
 * Pure history-picker navigation and line-budget windowing.
 * Framework-free (no OpenTUI / solid-js). Uses Todo 1 formatters for row height
 * and time-column strings.
 */

import type { TuiPromptHistoryEntry } from '@mission-control/protocol';
import { formatHistoryContentPreview, formatHistoryTimeColumn } from './history-picker-format.js';

/** Aligns with durable `TuiPromptHistoryEntry` (id, text, timestamp ms). */
export type HistoryPickerEntry = TuiPromptHistoryEntry;

/**
 * Picker open/selection state.
 * `draftSnapshot` is the input buffer when the picker opened (Esc does not
 * overwrite the textarea; snapshot is kept for callers that need it).
 */
export type HistoryPickerState = {
    readonly open: boolean;
    readonly selectedIndex: number;
    readonly draftSnapshot: string;
};

export type HistoryPickerDirection = 'up' | 'down';

export type HistoryPickerVisibleRow = {
    readonly entry: HistoryPickerEntry;
    readonly previewLines: readonly string[];
    readonly timeColumn: string;
    readonly selected: boolean;
    readonly globalIndex: number;
};

export type HistoryPickerView =
    | {
          readonly empty: true;
          readonly message: 'No prompt history';
          readonly open: boolean;
          readonly selectedIndex: number;
          readonly totalCount: 0;
          readonly rows: readonly [];
      }
    | {
          readonly empty: false;
          readonly open: boolean;
          readonly selectedIndex: number;
          readonly totalCount: number;
          readonly startIndex: number;
          readonly endIndex: number;
          readonly rows: readonly HistoryPickerVisibleRow[];
      };

const EMPTY_MESSAGE = 'No prompt history' as const;

/** Closed picker with selection at newest (index 0) and empty draft snapshot. */
export function createHistoryPickerState(): HistoryPickerState {
    return { open: false, selectedIndex: 0, draftSnapshot: '' };
}

/**
 * Open the picker on a newest-first entry list.
 * Selected index starts at 0 (newest). Empty lists still open.
 */
export function openHistoryPicker(
    _state: HistoryPickerState,
    _entriesNewestFirst: readonly HistoryPickerEntry[],
    currentInput: string,
): HistoryPickerState {
    return {
        open: true,
        selectedIndex: 0,
        draftSnapshot: currentInput,
    };
}

/**
 * Move selection by one step. `up` decreases index (toward newer / top);
 * `down` increases index (toward older / bottom). No-op when closed or empty.
 */
export function navigateHistoryPicker(
    state: HistoryPickerState,
    direction: HistoryPickerDirection,
    entryCount: number,
): HistoryPickerState {
    if (!state.open || entryCount <= 0) {
        return state;
    }
    const delta = direction === 'up' ? -1 : 1;
    const next = clampIndex(state.selectedIndex + delta, entryCount);
    if (next === state.selectedIndex) {
        return state;
    }
    return { ...state, selectedIndex: next };
}

/** Close the picker; keeps selectedIndex and draftSnapshot. */
export function closeHistoryPicker(state: HistoryPickerState): HistoryPickerState {
    if (!state.open) {
        return state;
    }
    return { ...state, open: false };
}

/**
 * Clamp `selectedIndex` into `[0, entryCount-1]` (or 0 when empty).
 * Use when the entry list shrinks under an open picker.
 */
export function clampHistoryPickerSelection(
    state: HistoryPickerState,
    entryCount: number,
): HistoryPickerState {
    const selectedIndex = entryCount <= 0 ? 0 : clampIndex(state.selectedIndex, entryCount);
    if (selectedIndex === state.selectedIndex) {
        return state;
    }
    return { ...state, selectedIndex };
}

/**
 * Pure view: window entries so the sum of preview row heights ≤ `maxLines`
 * (minimum 1), always including the selected entry when the list is non-empty.
 */
export function createHistoryPickerView(
    entriesNewestFirst: readonly HistoryPickerEntry[],
    state: HistoryPickerState,
    maxLines: number,
    nowMs: number,
): HistoryPickerView {
    const open = state.open;
    const totalCount = entriesNewestFirst.length;
    if (totalCount === 0) {
        return {
            empty: true,
            message: EMPTY_MESSAGE,
            open,
            selectedIndex: 0,
            totalCount: 0,
            rows: [],
        };
    }

    const lineBudget = Math.max(1, maxLines);
    const selectedIndex = clampIndex(state.selectedIndex, totalCount);
    const heights = entriesNewestFirst.map((entry) => formatHistoryContentPreview(entry.text).length);
    const { startIndex, endIndex } = windowByLineBudget(heights, selectedIndex, lineBudget);

    const rows: HistoryPickerVisibleRow[] = [];
    for (let globalIndex = startIndex; globalIndex <= endIndex; globalIndex += 1) {
        const entry = entriesNewestFirst[globalIndex];
        if (entry === undefined) {
            continue;
        }
        rows.push({
            entry,
            previewLines: formatHistoryContentPreview(entry.text),
            timeColumn: formatHistoryTimeColumn(entry.timestamp, nowMs),
            selected: globalIndex === selectedIndex,
            globalIndex,
        });
    }

    return {
        empty: false,
        open,
        selectedIndex,
        totalCount,
        startIndex,
        endIndex,
        rows,
    };
}

function clampIndex(index: number, entryCount: number): number {
    if (entryCount <= 0) {
        return 0;
    }
    return Math.min(Math.max(index, 0), entryCount - 1);
}

/**
 * Contiguous window of variable-height rows that includes `selectedIndex` and
 * whose height sum is ≤ `maxLines`. Expands outward from the selection,
 * alternating up then down so the selection stays roughly centered.
 * If the selected row alone exceeds the budget, it is still the only row shown.
 */
function windowByLineBudget(
    heights: readonly number[],
    selectedIndex: number,
    maxLines: number,
): { readonly startIndex: number; readonly endIndex: number } {
    const total = heights.length;
    if (total === 0) {
        return { startIndex: 0, endIndex: 0 };
    }
    const selected = clampIndex(selectedIndex, total);
    const selectedHeight = heights[selected] ?? 1;
    let start = selected;
    let end = selected;
    let used = selectedHeight;
    let preferDown = false;

    while (true) {
        const canUp = start > 0 && used + (heights[start - 1] ?? 0) <= maxLines;
        const canDown = end < total - 1 && used + (heights[end + 1] ?? 0) <= maxLines;
        if (!canUp && !canDown) {
            break;
        }
        if (canUp && canDown) {
            if (preferDown) {
                end += 1;
                used += heights[end] ?? 0;
            } else {
                start -= 1;
                used += heights[start] ?? 0;
            }
            preferDown = !preferDown;
        } else if (canUp) {
            start -= 1;
            used += heights[start] ?? 0;
        } else {
            end += 1;
            used += heights[end] ?? 0;
        }
    }

    return { startIndex: start, endIndex: end };
}
