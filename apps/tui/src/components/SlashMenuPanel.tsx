import { terminalDisplayWidth } from '@mission-control/tui';
import { TextAttributes } from '@opentui/core';
import { For, type JSX } from 'solid-js';
import {
    createSkillCommandMenuView,
    createSlashCommandMenuView,
    createWorkflowCommandMenuView,
    type SlashCommandMenuState,
} from '../state/interactive-chat-command-menu';
import { OverlayFrame } from './OverlayFrame';
import { SELECTED_BG } from './overlay-theme';

export type SlashMenuPanelProps = {
    readonly inputBuffer: string;
    readonly menuState: SlashCommandMenuState;
    readonly workflowNames: readonly string[];
    readonly skillNames: readonly string[];
    readonly maxVisibleRows?: number;
    readonly showFooter?: boolean;
};

const MAX_VISIBLE = 5;
const FOOTER = 'Up/Down to navigate, Enter to select, Esc to close';

export function SlashMenuPanel({
    inputBuffer,
    menuState,
    workflowNames,
    skillNames,
    maxVisibleRows = MAX_VISIBLE,
    showFooter = true,
}: SlashMenuPanelProps): JSX.Element | null {
    const isSlash = inputBuffer.startsWith('/');
    const isWorkflow = inputBuffer.startsWith('#');
    const isSkill = inputBuffer.startsWith('$');
    if (!isSlash && !isWorkflow && !isSkill) return null;
    if (maxVisibleRows <= 0) return null;

    const view = isSlash
        ? createSlashCommandMenuView(inputBuffer, menuState, maxVisibleRows)
        : isWorkflow
          ? createWorkflowCommandMenuView(inputBuffer, menuState, maxVisibleRows, workflowNames)
          : createSkillCommandMenuView(inputBuffer, menuState, maxVisibleRows, skillNames);

    if (!view.open) return null;

    const header = isSlash
        ? view.query.length > 0
            ? ` Commands matching "${view.query}" `
            : ` Commands (${view.totalCount}) `
        : isWorkflow
          ? view.query.length > 0
              ? ` Workflows matching "${view.query}" `
              : ` Workflows (${view.totalCount}) `
          : view.query.length > 0
            ? ` Skills matching "${view.query}" `
            : ` Skills (${view.totalCount}) `;
    const idWidth =
        view.visibleChoices.length > 0 ? Math.max(8, ...view.visibleChoices.map((c) => terminalDisplayWidth(c.id))) : 8;

    return (
        <OverlayFrame variant="panel" title={header.trim()} {...(showFooter ? { footer: FOOTER } : {})}>
            <box height={1} />
            {view.empty ? (
                <text attributes={TextAttributes.DIM}> no matches</text>
            ) : (
                <For each={view.visibleChoices}>
                    {(choice, index) => {
                        const globalIndex = view.startIndex + index();
                        const isSelected = globalIndex === view.selectedIndex;
                        const padding = ' '.repeat(Math.max(0, idWidth - terminalDisplayWidth(choice.id)));
                        const pickerMarker = choice.opensPicker === true ? ' \u2026' : '';
                        const selectedBg = isSelected ? { bg: SELECTED_BG } : {};
                        const line = `${isSelected ? '> ' : '  '}${choice.id}${padding}${pickerMarker}  ${choice.description}`;
                        return (
                            <box height={1}>
                                <text {...selectedBg}>{line}</text>
                            </box>
                        );
                    }}
                </For>
            )}
        </OverlayFrame>
    );
}
