/** @jsxImportSource @opentui/react */

import { terminalDisplayWidth } from '@mission-control/tui';
import { TextAttributes } from '@opentui/core';
import type * as React from 'react';
import {
    createSlashCommandMenuView,
    createWorkflowCommandMenuView,
    type SlashCommandMenuState,
} from '../state/interactive-chat-command-menu.js';
import { OverlayFrame } from './OverlayFrame.js';
import { SELECTED_BG } from './overlay-theme.js';

export type SlashMenuPanelProps = {
    readonly inputBuffer: string;
    readonly menuState: SlashCommandMenuState;
    readonly workflowNames: readonly string[];
    readonly maxVisibleRows?: number;
    readonly showFooter?: boolean;
};

const MAX_VISIBLE = 5;
const FOOTER = 'Up/Down to navigate, Enter to select, Esc to close';

export function SlashMenuPanel({
    inputBuffer,
    menuState,
    workflowNames,
    maxVisibleRows = MAX_VISIBLE,
    showFooter = true,
}: SlashMenuPanelProps): React.ReactNode {
    const isSlash = inputBuffer.startsWith('/');
    const isWorkflow = inputBuffer.startsWith('#');
    if (!isSlash && !isWorkflow) return null;
    if (maxVisibleRows <= 0) return null;

    const view = isSlash
        ? createSlashCommandMenuView(inputBuffer, menuState, maxVisibleRows)
        : createWorkflowCommandMenuView(inputBuffer, menuState, maxVisibleRows, workflowNames);

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
        <OverlayFrame variant="panel" title={header.trim()} {...(showFooter ? { footer: FOOTER } : {})}>
            <box height={1} />
            {items}
        </OverlayFrame>
    );
}
