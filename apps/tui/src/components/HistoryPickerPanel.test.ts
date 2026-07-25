import { describe, expect, it } from 'vitest';
import { historyPickerPromptListControls } from './prompt-list-controls';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('HistoryPickerPanel prompt-list adapter', () => {
    it('projects the history state window into multiline prompt and timestamp columns', () => {
        const source = readFileSync(resolve(process.cwd(), 'apps/tui/src/components/HistoryPickerPanel.tsx'), 'utf8');

        expect(source).toContain('createHistoryPickerView');
        expect(source).toContain('PromptListPanel');
        expect(source).toContain("{ id: 'prompt', width: 'fill' }");
        expect(source).toContain("{ id: 'time', width: 'fit', minWidth: 14, dim: true }");
        expect(source).toContain('row.previewLines.length > 0 ? row.previewLines');
        expect(source).toContain('selected: row.selected');
        expect(source).toContain('{ lines: [row.timeColumn] }');
        expect(source).not.toContain('OverlayFrame');
        expect(source).not.toContain('SELECTED_BG');
        expect(source).not.toContain('layoutHistoryPickerRow');
    });

    it('uses the shared non-filterable history insertion controls', () => {
        expect(historyPickerPromptListControls).toEqual({
            filterable: false,
            selectable: true,
            acceptKeys: ['tab', 'enter'],
            acceptVerb: 'insert',
            dismissible: true,
        });
    });
});
