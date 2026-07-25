/** @jsxImportSource @opentui/solid */

import { createMemo, Show, type JSX } from 'solid-js';
import { createFileAutocompleteView, type FileAutocompleteState } from '../state/interactive-chat-file-autocomplete';
import { completionPromptListControls } from './prompt-list-controls';
import { PromptListPanel, type PromptListColumn, type PromptListRow } from './PromptListPanel';

export type FileAutocompletePanelProps = {
    readonly fileAutocomplete: FileAutocompleteState;
    readonly maxVisibleRows?: number;
    readonly viewportColumns: number;
    readonly showFooter?: boolean;
};

const MAX_VISIBLE = 8;
const fileColumns = [{ id: 'file', width: 'fill' }] as const satisfies readonly PromptListColumn[];

export function FileAutocompletePanel(props: FileAutocompletePanelProps): JSX.Element {
    const maxVisibleRows = createMemo(() => props.maxVisibleRows ?? MAX_VISIBLE);
    const view = createMemo(() => createFileAutocompleteView(props.fileAutocomplete, maxVisibleRows()));
    const rows = createMemo<readonly PromptListRow[]>(() => {
        const current = view();
        return current.visibleMatches.map((match, index) => {
            const globalIndex = current.startIndex + index;
            return {
                id: `${globalIndex}:${match.name}`,
                cells: [{ lines: [`${match.isDirectory ? '/' : ' '}${match.name}`] }],
                selected: globalIndex === current.selectedIndex,
            };
        });
    });
    const title = (): string => {
        const current = view();
        return current.totalCount > 0
            ? `Files matching @${current.prefix} (${current.totalCount})`
            : `Files matching @${current.prefix}`;
    };

    return (
        <Show when={maxVisibleRows() > 0 && view().open}>
            <PromptListPanel
                title={title()}
                rows={rows()}
                columns={fileColumns}
                viewportColumns={props.viewportColumns}
                emptyMessage="no files match"
                controls={completionPromptListControls}
                {...(props.showFooter !== undefined ? { showFooter: props.showFooter } : {})}
            />
        </Show>
    );
}
