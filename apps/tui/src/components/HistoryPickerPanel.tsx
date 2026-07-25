/** @jsxImportSource @opentui/solid */

import { createMemo, Show, type JSX } from 'solid-js';
import {
    createHistoryPickerView,
    type HistoryPickerEntry,
    type HistoryPickerState,
} from '../state/history-picker-state';
import { historyPickerPromptListControls } from './prompt-list-controls';
import { PromptListPanel, type PromptListColumn, type PromptListRow } from './PromptListPanel';

export type HistoryPickerPanelProps = {
    readonly entries: readonly HistoryPickerEntry[];
    readonly pickerState: HistoryPickerState;
    readonly maxLines: number;
    readonly viewportColumns: number;
    readonly nowMs?: number;
    readonly showFooter?: boolean;
};

const historyColumns = [
    { id: 'prompt', width: 'fill' },
    { id: 'time', width: 'fit', minWidth: 14, dim: true },
] as const satisfies readonly PromptListColumn[];

export function HistoryPickerPanel(props: HistoryPickerPanelProps): JSX.Element {
    const view = createMemo(() =>
        createHistoryPickerView(props.entries, props.pickerState, props.maxLines, props.nowMs ?? Date.now()),
    );
    const rows = createMemo<readonly PromptListRow[]>(() => {
        const current = view();
        if (current.empty) return [];
        return current.rows.map((row) => ({
            id: row.entry.id,
            cells: [
                { lines: row.previewLines.length > 0 ? row.previewLines : [''] },
                { lines: [row.timeColumn] },
            ],
            selected: row.selected,
        }));
    });
    const title = (): string => {
        const current = view();
        return current.empty || current.totalCount === 0 ? 'Prompt history' : `Prompt history (${current.totalCount})`;
    };

    return (
        <Show when={props.pickerState.open && props.maxLines > 0}>
            <PromptListPanel
                title={title()}
                rows={rows()}
                columns={historyColumns}
                viewportColumns={props.viewportColumns}
                emptyMessage="No prompt history"
                controls={historyPickerPromptListControls}
                {...(props.showFooter !== undefined ? { showFooter: props.showFooter } : {})}
            />
        </Show>
    );
}
