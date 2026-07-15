import { terminalDisplayWidth } from '@mission-control/tui';
import { describe, expect, it, vi } from 'vitest';
import type { HistoryPickerVisibleRow } from '../state/history-picker-state';
import {
    computeHistoryContentColumnWidth,
    computeHistoryTimeColumnWidth,
    layoutHistoryPickerRow,
} from './HistoryPickerPanel';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@mission-control/tui', async () => await import('../terminal-text'));

function makeRow(overrides: Partial<HistoryPickerVisibleRow> = {}): HistoryPickerVisibleRow {
    return {
        entry: { id: 'h1', text: 'hello', timestamp: 1_700_000_000_000 },
        previewLines: ['hello'],
        timeColumn: '14:30 (5m ago)',
        selected: false,
        globalIndex: 0,
        ...overrides,
    };
}

describe('computeHistoryTimeColumnWidth', () => {
    it('uses at least 14 columns even when times are short', () => {
        expect(computeHistoryTimeColumnWidth(['— (—)'])).toBe(14);
        expect(computeHistoryTimeColumnWidth([])).toBe(14);
    });

    it('expands to the widest visible time string', () => {
        const wide = 'Jul 9 14:30 (yesterday)';
        expect(computeHistoryTimeColumnWidth(['14:30 (5m ago)', wide])).toBe(Math.max(14, terminalDisplayWidth(wide)));
    });
});

describe('computeHistoryContentColumnWidth', () => {
    it('reserves marker, gap, and time column from total columns', () => {
        // columns 80, time 14 → content = 80 - 1 - 2 - 2 - 14 = 61
        expect(computeHistoryContentColumnWidth(80, 14)).toBe(61);
    });

    it('never returns less than 1', () => {
        expect(computeHistoryContentColumnWidth(10, 20)).toBe(1);
    });
});

describe('layoutHistoryPickerRow', () => {
    it('puts the selection marker and time only on the first line', () => {
        const row = makeRow({
            selected: true,
            previewLines: ['line one', 'line two'],
            timeColumn: '14:30 (5m ago)',
        });
        const lines = layoutHistoryPickerRow(row, 20, 14);
        expect(lines).toHaveLength(2);
        expect(lines[0]?.content.startsWith('> ')).toBe(true);
        expect(lines[0]?.time).toBeDefined();
        expect(terminalDisplayWidth(lines[0]?.time ?? '')).toBe(14);
        expect(lines[1]?.content.startsWith('  ')).toBe(true);
        expect(lines[1]?.time).toBeUndefined();
        expect(lines[0]?.selected).toBe(true);
        expect(lines[1]?.selected).toBe(true);
    });

    it('truncates a single long content line to the content width', () => {
        const long = 'x'.repeat(80);
        const row = makeRow({ previewLines: [long], selected: false });
        const lines = layoutHistoryPickerRow(row, 12, 14);
        expect(lines).toHaveLength(1);
        // marker (2) + content (12) = 14 display columns for content field
        expect(terminalDisplayWidth(lines[0]?.content ?? '')).toBe(14);
        expect(lines[0]?.content.includes('\u2026') || lines[0]?.content.includes('~')).toBe(true);
    });

    it('uses a blank content line when preview is empty', () => {
        const row = makeRow({ previewLines: [] });
        const lines = layoutHistoryPickerRow(row, 10, 14);
        expect(lines).toHaveLength(1);
        expect(lines[0]?.content.startsWith('  ')).toBe(true);
    });
});

describe('HistoryPickerPanel closed / zero budget contract', () => {
    it('returns null when closed or maxLines is zero (source topology)', () => {
        const source = readFileSync(resolve(process.cwd(), 'apps/tui/src/components/HistoryPickerPanel.tsx'), 'utf8');
        expect(source).toContain('createHistoryPickerView');
        expect(source).toContain('SELECTED_BG');
        expect(source).toContain('OverlayFrame');
        expect(source).toContain('variant="panel"');
        expect(source).toContain('No prompt history');
        expect(source).toContain('Up/Down navigate, Enter insert, Esc close');
        expect(source).toContain('props.pickerState.open');
        expect(source).toContain('props.maxLines > 0');
        expect(source).toContain('<Show when={open()}>');
    });
});
