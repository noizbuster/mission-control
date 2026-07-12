import { describe, expect, it } from 'vitest';
import {
    clampHistoryPickerSelection,
    closeHistoryPicker,
    createHistoryPickerState,
    createHistoryPickerView,
    navigateHistoryPicker,
    openHistoryPicker,
    type HistoryPickerEntry,
} from './history-picker-state.js';

const NOW_MS = new Date(2026, 6, 10, 12, 0, 0, 0).getTime();

function entry(id: string, text: string, timestamp: number = NOW_MS - 60_000): HistoryPickerEntry {
    return { id, text, timestamp };
}

function singleLineEntries(count: number): readonly HistoryPickerEntry[] {
    return Array.from({ length: count }, (_, index) =>
        entry(`e${index}`, `line-${index}`, NOW_MS - index * 60_000),
    );
}

describe('createHistoryPickerState', () => {
    it('starts closed at selectedIndex 0 with empty draft', () => {
        expect(createHistoryPickerState()).toEqual({
            open: false,
            selectedIndex: 0,
            draftSnapshot: '',
        });
    });
});

describe('openHistoryPicker', () => {
    it('opens with selectedIndex 0 and stores draftSnapshot', () => {
        const closed = createHistoryPickerState();
        const entries = singleLineEntries(3);
        const opened = openHistoryPicker(closed, entries, 'draft text');
        expect(opened).toEqual({
            open: true,
            selectedIndex: 0,
            draftSnapshot: 'draft text',
        });
    });

    it('opens even when entries are empty', () => {
        const opened = openHistoryPicker(createHistoryPickerState(), [], 'x');
        expect(opened.open).toBe(true);
        expect(opened.selectedIndex).toBe(0);
        expect(opened.draftSnapshot).toBe('x');
    });
});

describe('navigateHistoryPicker', () => {
    it('is a no-op when closed', () => {
        const closed = createHistoryPickerState();
        expect(navigateHistoryPicker(closed, 'down', 5)).toBe(closed);
        expect(navigateHistoryPicker(closed, 'up', 5)).toBe(closed);
    });

    it('is a no-op when entryCount is 0', () => {
        const open = openHistoryPicker(createHistoryPickerState(), [], '');
        expect(navigateHistoryPicker(open, 'down', 0)).toBe(open);
    });

    it('moves down toward older (higher index) and clamps at end', () => {
        let state = openHistoryPicker(createHistoryPickerState(), singleLineEntries(3), '');
        state = navigateHistoryPicker(state, 'down', 3);
        expect(state.selectedIndex).toBe(1);
        state = navigateHistoryPicker(state, 'down', 3);
        expect(state.selectedIndex).toBe(2);
        const atEnd = navigateHistoryPicker(state, 'down', 3);
        expect(atEnd).toBe(state);
        expect(atEnd.selectedIndex).toBe(2);
    });

    it('moves up toward newer (lower index) and clamps at start', () => {
        let state = openHistoryPicker(createHistoryPickerState(), singleLineEntries(3), '');
        state = navigateHistoryPicker(state, 'down', 3);
        state = navigateHistoryPicker(state, 'down', 3);
        expect(state.selectedIndex).toBe(2);
        state = navigateHistoryPicker(state, 'up', 3);
        expect(state.selectedIndex).toBe(1);
        state = navigateHistoryPicker(state, 'up', 3);
        expect(state.selectedIndex).toBe(0);
        const atStart = navigateHistoryPicker(state, 'up', 3);
        expect(atStart).toBe(state);
    });
});

describe('closeHistoryPicker', () => {
    it('sets open false and preserves selection and draft', () => {
        const open = openHistoryPicker(createHistoryPickerState(), singleLineEntries(2), 'keep');
        const navigated = navigateHistoryPicker(open, 'down', 2);
        const closed = closeHistoryPicker(navigated);
        expect(closed.open).toBe(false);
        expect(closed.selectedIndex).toBe(1);
        expect(closed.draftSnapshot).toBe('keep');
    });

    it('is a no-op when already closed', () => {
        const closed = createHistoryPickerState();
        expect(closeHistoryPicker(closed)).toBe(closed);
    });
});

describe('clampHistoryPickerSelection', () => {
    it('clamps selectedIndex when the entry list shrinks', () => {
        let state = openHistoryPicker(createHistoryPickerState(), singleLineEntries(5), '');
        state = navigateHistoryPicker(state, 'down', 5);
        state = navigateHistoryPicker(state, 'down', 5);
        state = navigateHistoryPicker(state, 'down', 5);
        expect(state.selectedIndex).toBe(3);
        const clamped = clampHistoryPickerSelection(state, 2);
        expect(clamped.selectedIndex).toBe(1);
    });

    it('resets to 0 when entryCount is 0', () => {
        const state = { open: true, selectedIndex: 4, draftSnapshot: '' };
        expect(clampHistoryPickerSelection(state, 0).selectedIndex).toBe(0);
    });
});

describe('createHistoryPickerView', () => {
    it('returns empty message when there are no entries', () => {
        const state = openHistoryPicker(createHistoryPickerState(), [], 'd');
        const view = createHistoryPickerView([], state, 5, NOW_MS);
        expect(view).toEqual({
            empty: true,
            message: 'No prompt history',
            open: true,
            selectedIndex: 0,
            totalCount: 0,
            rows: [],
        });
    });

    it('windows 10 single-line entries to maxLines=5 and scrolls with selection', () => {
        const entries = singleLineEntries(10);
        let state = openHistoryPicker(createHistoryPickerState(), entries, '');
        let view = createHistoryPickerView(entries, state, 5, NOW_MS);
        expect(view.empty).toBe(false);
        if (view.empty) return;
        expect(view.rows).toHaveLength(5);
        expect(view.startIndex).toBe(0);
        expect(view.endIndex).toBe(4);
        expect(view.rows[0]?.selected).toBe(true);
        expect(view.rows[0]?.globalIndex).toBe(0);
        expect(view.rows.every((row) => row.previewLines.length === 1)).toBe(true);

        // Move selection to the last entry — window should include it.
        for (let i = 0; i < 9; i += 1) {
            state = navigateHistoryPicker(state, 'down', 10);
        }
        expect(state.selectedIndex).toBe(9);
        view = createHistoryPickerView(entries, state, 5, NOW_MS);
        if (view.empty) return;
        expect(view.rows).toHaveLength(5);
        expect(view.endIndex).toBe(9);
        expect(view.startIndex).toBe(5);
        expect(view.rows[view.rows.length - 1]?.selected).toBe(true);
        expect(view.rows[view.rows.length - 1]?.globalIndex).toBe(9);
    });

    it('fills maxLines=5 with a single 5-line preview entry', () => {
        const text = 'l0\nl1\nl2\nl3\nl4';
        const entries = [entry('tall', text)];
        const state = openHistoryPicker(createHistoryPickerState(), entries, '');
        const view = createHistoryPickerView(entries, state, 5, NOW_MS);
        expect(view.empty).toBe(false);
        if (view.empty) return;
        expect(view.rows).toHaveLength(1);
        expect(view.rows[0]?.previewLines).toEqual(['l0', 'l1', '…', 'l3', 'l4']);
        expect(view.rows[0]?.previewLines).toHaveLength(5);
        expect(view.startIndex).toBe(0);
        expect(view.endIndex).toBe(0);
    });

    it('includes selected multi-line entry and neighbors within line budget', () => {
        const entries = [
            entry('a', 'one'),
            entry('b', 'two\nlines'),
            entry('c', 'three'),
        ];
        let state = openHistoryPicker(createHistoryPickerState(), entries, '');
        state = navigateHistoryPicker(state, 'down', 3);
        expect(state.selectedIndex).toBe(1);
        const view = createHistoryPickerView(entries, state, 4, NOW_MS);
        if (view.empty) return;
        // heights: 1 + 2 + 1 = 4 → all three fit
        expect(view.rows).toHaveLength(3);
        expect(view.rows[1]?.selected).toBe(true);
        expect(view.rows[1]?.previewLines).toEqual(['two', 'lines']);
    });

    it('emits timeColumn via formatters on each visible row', () => {
        const fiveMinAgo = new Date(2026, 6, 10, 11, 55, 0, 0).getTime();
        const entries = [entry('t', 'hello', fiveMinAgo)];
        const state = openHistoryPicker(createHistoryPickerState(), entries, '');
        const view = createHistoryPickerView(entries, state, 3, NOW_MS);
        if (view.empty) return;
        expect(view.rows[0]?.timeColumn).toBe('11:55 (5m ago)');
    });

    it('clamps out-of-range selectedIndex when building the view', () => {
        const entries = singleLineEntries(2);
        const state = { open: true, selectedIndex: 99, draftSnapshot: '' };
        const view = createHistoryPickerView(entries, state, 5, NOW_MS);
        if (view.empty) return;
        expect(view.selectedIndex).toBe(1);
        expect(view.rows.some((row) => row.selected)).toBe(true);
    });

    it('reports open flag from state even when closed', () => {
        const entries = singleLineEntries(1);
        const closed = createHistoryPickerState();
        const view = createHistoryPickerView(entries, closed, 5, NOW_MS);
        expect(view.open).toBe(false);
        expect(view.empty).toBe(false);
    });
});
