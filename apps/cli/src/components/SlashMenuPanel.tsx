/** @jsxImportSource @opentui/react */
import { TextAttributes } from '@opentui/core';
import type * as React from 'react';
import {
    createSlashCommandMenuView,
    createWorkflowCommandMenuView,
    type SlashCommandMenuState,
} from '../commands/interactive-chat-command-menu.js';
import { terminalDisplayWidth } from '../commands/terminal-text.js';
import { OverlayFrame } from './OverlayFrame.js';
import { SELECTED_BG } from './overlay-theme.js';

export type SlashMenuPanelProps = {
    readonly inputBuffer: string;
    readonly menuState: SlashCommandMenuState;
    readonly workflowNames: readonly string[];
};

const MAX_VISIBLE = 5;

export function SlashMenuPanel({ inputBuffer, menuState, workflowNames }: SlashMenuPanelProps): React.ReactNode {
    const isSlash = inputBuffer.startsWith('/');
    const isWorkflow = inputBuffer.startsWith('#');
    if (!isSlash && !isWorkflow) return null;

    const view = isSlash
        ? createSlashCommandMenuView(inputBuffer, menuState, MAX_VISIBLE)
        : createWorkflowCommandMenuView(inputBuffer, menuState, MAX_VISIBLE, workflowNames);

    if (!view.open) return null;

    const header = isSlash
        ? view.query.length > 0
            ? ` Commands matching "${view.query}" `
            : ` Commands (${view.totalCount}) `
        : view.query.length > 0
          ? ` Workflows matching "${view.query}" `
          : ` Workflows (${view.totalCount}) `;

    const idWidth =
        view.visibleChoices.length > 0 ? Math.max(8, ...view.visibleChoices.map((c) => terminalDisplayWidth(c.id))) : 8;

    const items: readonly React.ReactNode[] = view.empty
        ? [
              <text key="empty" attributes={TextAttributes.DIM}>
                  {' '}
                  no matches
              </text>,
          ]
        : view.visibleChoices.map((choice, index) => {
              const globalIndex = view.startIndex + index;
              const isSelected = globalIndex === view.selectedIndex;
              const padding = ' '.repeat(Math.max(0, idWidth - terminalDisplayWidth(choice.id)));
              const pickerMarker = choice.opensPicker === true ? ' \u2026' : '';
              const selectedBg = isSelected ? { bg: SELECTED_BG } : {};
              const line = `${isSelected ? '> ' : '  '}${choice.id}${padding}${pickerMarker}  ${choice.description}`;
              return (
                  <box key={choice.id} height={1}>
                      <text {...selectedBg}>{line}</text>
                  </box>
              );
          });

    return (
        <OverlayFrame variant="panel" title={header.trim()} footer="Up/Down to navigate, Enter to select, Esc to close">
            <box height={1} />
            {items}
        </OverlayFrame>
    );
}
