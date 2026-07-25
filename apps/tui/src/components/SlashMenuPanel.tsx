/** @jsxImportSource @opentui/solid */

import type { TuiSkillMenuEntry } from '@mission-control/protocol';
import { createMemo, Show, type JSX } from 'solid-js';
import {
    createSkillCommandMenuView,
    createSlashCommandMenuView,
    createWorkflowCommandMenuView,
    type SlashCommandMenuState,
} from '../state/interactive-chat-command-menu';
import { completionPromptListControls } from './prompt-list-controls';
import { PromptListPanel, type PromptListColumn, type PromptListRow } from './PromptListPanel';

export type SlashMenuPanelProps = {
    readonly inputBuffer: string;
    readonly menuState: SlashCommandMenuState;
    readonly workflowNames: readonly string[];
    readonly skillEntries: readonly TuiSkillMenuEntry[];
    readonly maxVisibleRows?: number;
    readonly viewportColumns: number;
    readonly showFooter?: boolean;
};

const MAX_VISIBLE = 5;
const commandColumns = [
    { id: 'command', width: 'fit', minWidth: 8 },
    { id: 'description', width: 'fill' },
] as const satisfies readonly PromptListColumn[];

export function SlashMenuPanel(props: SlashMenuPanelProps): JSX.Element {
    const maxVisibleRows = createMemo(() => props.maxVisibleRows ?? MAX_VISIBLE);
    const view = createMemo(() => {
        if (props.inputBuffer.startsWith('/')) {
            return createSlashCommandMenuView(props.inputBuffer, props.menuState, maxVisibleRows());
        }
        if (props.inputBuffer.startsWith('#')) {
            return createWorkflowCommandMenuView(
                props.inputBuffer,
                props.menuState,
                maxVisibleRows(),
                props.workflowNames,
            );
        }
        return createSkillCommandMenuView(props.inputBuffer, props.menuState, maxVisibleRows(), props.skillEntries);
    });
    const rows = createMemo<readonly PromptListRow[]>(() => {
        const current = view();
        return current.visibleChoices.map((choice, index) => {
            const globalIndex = current.startIndex + index;
            return {
                id: choice.id,
                cells: [
                    { lines: [choice.opensPicker === true ? `${choice.id} …` : choice.id] },
                    { lines: [choice.description] },
                ],
                selected: globalIndex === current.selectedIndex,
            };
        });
    });
    const title = (): string => {
        const current = view();
        const label = props.inputBuffer.startsWith('/')
            ? 'Commands'
            : props.inputBuffer.startsWith('#')
              ? 'Workflows'
              : 'Skills';
        return current.query.length > 0 ? `${label} matching "${current.query}"` : `${label} (${current.totalCount})`;
    };

    return (
        <Show when={maxVisibleRows() > 0 && view().open}>
            <PromptListPanel
                title={title()}
                rows={rows()}
                columns={commandColumns}
                viewportColumns={props.viewportColumns}
                emptyMessage="no matches"
                controls={completionPromptListControls}
                {...(props.showFooter !== undefined ? { showFooter: props.showFooter } : {})}
            />
        </Show>
    );
}
