import { terminalDisplayWidth } from '@mission-control/tui';
import { describe, expect, it, vi } from 'vitest';
import { formatPromptListControlsFooter, layoutPromptListRows } from './PromptListPanel';

vi.mock('@mission-control/tui', async () => await import('../terminal-text'));

describe('layoutPromptListRows', () => {
    it('fits CJK text by terminal display width without splitting graphemes', () => {
        const layout = layoutPromptListRows(
            [
                {
                    id: 'tokyo',
                    cells: [{ lines: ['日本語'] }, { lines: ['東京サーバー'] }],
                    selected: true,
                },
            ],
            [
                { id: 'name', width: 'fit', minWidth: 4, maxWidth: 4 },
                { id: 'description', width: 'fill' },
            ],
            13,
        );

        const line = layout.lines[0];
        const renderedCells = line === undefined ? '' : line.cells.map((cell) => cell.text).join(line.columnGap);
        expect(layout.columnWidths).toEqual([4, 5]);
        expect(line?.cells[1]?.text).toBe('東京…');
        expect(terminalDisplayWidth(line?.cells[0]?.text ?? '')).toBe(4);
        expect(
            terminalDisplayWidth(
                `${line?.marker ?? ''}${renderedCells}${line?.trailingPadding ?? ''}`,
            ),
        ).toBe(13);
    });

    it('keeps fit columns bounded and divides remaining width among fill columns', () => {
        const layout = layoutPromptListRows(
            [
                {
                    id: 'deploy',
                    cells: [{ lines: ['/deploy'] }, { lines: ['Deploy the selected revision'] }, { lines: ['stable'] }],
                    selected: false,
                },
            ],
            [
                { id: 'command', width: 'fit', minWidth: 8, maxWidth: 10 },
                { id: 'summary', width: 'fill', minWidth: 4 },
                { id: 'channel', width: 'fill', minWidth: 4, maxWidth: 6 },
            ],
            36,
        );

        expect(layout.columnWidths).toEqual([8, 16, 6]);
        expect(
            layout.columnWidths.reduce((total, width) => total + width, 0) +
                layout.markerWidth +
                2 * (layout.columnWidths.length - 1),
        ).toBe(36);
    });

    it('aligns multiline cells while marking only the first selected line', () => {
        const layout = layoutPromptListRows(
            [
                {
                    id: 'history-entry',
                    cells: [{ lines: ['first prompt line', 'continued prompt line'] }, { lines: ['14:30'] }],
                    selected: true,
                },
            ],
            [
                { id: 'prompt', width: 'fill' },
                { id: 'time', width: 'fit', minWidth: 4 },
            ],
            30,
        );

        expect(layout.lines).toHaveLength(2);
        expect(layout.lines[0]).toMatchObject({ marker: '> ', continuation: false, selected: true });
        expect(layout.lines[1]).toMatchObject({ marker: '  ', continuation: true, selected: true });
        expect(layout.lines[0]?.cells[1]?.text.trim()).toBe('14:30');
        expect(layout.lines[1]?.cells[1]?.text.trim()).toBe('');
    });

    it('suppresses selection markers and selected paint when selection is disabled', () => {
        const layout = layoutPromptListRows(
            [{ id: 'plain', cells: [{ lines: ['plain row'] }], selected: true }],
            [{ id: 'label', width: 'fill' }],
            20,
            false,
        );

        expect(layout.markerWidth).toBe(0);
        expect(layout.lines[0]).toMatchObject({ marker: '', selected: false });
    });

    it('keeps an unselected row inside a one-column viewport', () => {
        const layout = layoutPromptListRows(
            [{ id: 'narrow', cells: [{ lines: ['東京'] }, { lines: ['details'] }], selected: false }],
            [
                { id: 'name', width: 'fit' },
                { id: 'details', width: 'fill' },
            ],
            1,
        );

        const line = layout.lines[0];
        const renderedCells = line === undefined ? '' : line.cells.map((cell) => cell.text).join(line.columnGap);
        expect(line).toMatchObject({ marker: ' ', selected: false });
        expect(terminalDisplayWidth(`${line?.marker ?? ''}${renderedCells}${line?.trailingPadding ?? ''}`)).toBe(1);
    });
});

describe('formatPromptListControlsFooter', () => {
    it('describes filterable completion controls in a stable key order', () => {
        expect(
            formatPromptListControlsFooter({
                filterable: true,
                selectable: true,
                acceptKeys: ['enter', 'tab'],
                acceptVerb: 'complete',
                dismissible: true,
            }),
        ).toBe('Type to filter, Up/Down navigate, Tab/Enter complete, Esc close');
    });

    it('describes history insertion without a filtering instruction', () => {
        expect(
            formatPromptListControlsFooter({
                filterable: false,
                selectable: true,
                acceptKeys: ['tab', 'enter'],
                acceptVerb: 'insert',
                dismissible: true,
            }),
        ).toBe('Up/Down navigate, Tab/Enter insert, Esc close');
    });

    it('omits unavailable navigation, acceptance, and dismissal controls', () => {
        expect(
            formatPromptListControlsFooter({
                filterable: true,
                selectable: false,
                acceptKeys: [],
                acceptVerb: 'complete',
                dismissible: false,
            }),
        ).toBe('Type to filter');
    });
});
