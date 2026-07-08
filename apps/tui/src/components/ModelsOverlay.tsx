/** @jsxImportSource @opentui/react */

import type { ModelProviderSelection } from '@mission-control/protocol';
import { padEndToDisplayWidth } from '@mission-control/tui';
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type * as React from 'react';
import { useCallback, useSyncExternalStore } from 'react';
import type { ChatStore } from '../state/chat-store.js';
import {
    createModelsOverlayView,
    formatRoleFallback,
    type ModelsOverlayRoleRow,
    type ModelsOverlayState,
} from '../state/models-overlay-state.js';
import { OverlayFrame } from './OverlayFrame.js';
import { SELECTED_BG } from './overlay-theme.js';

const MODELS_OVERLAY_MAX_VISIBLE = 12;

/**
 * Printable characters accepted by the search input: letters, digits, and the
 * model-string delimiters `/ - _ . #`. opentui delivers printable keys with a
 * single-char `key.name`; the `!ctrl && !meta` guard avoids hijiking chords.
 */
const SEARCH_INPUT_PATTERN = /^[a-zA-Z0-9/_\-.#]$/;

function isSearchInputKey(key: { readonly name: string; readonly ctrl: boolean; readonly meta: boolean }): boolean {
    return !key.ctrl && !key.meta && SEARCH_INPUT_PATTERN.test(key.name);
}

export type ModelsOverlayProps = { readonly store: ChatStore };

function useStoreSnapshot(store: ChatStore) {
    const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
    const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
    return useSyncExternalStore(subscribe, getSnapshot);
}

function formatSelection(selection: ModelProviderSelection): string {
    return selection.variantID !== undefined
        ? `${selection.providerID}/${selection.modelID}#${selection.variantID}`
        : `${selection.providerID}/${selection.modelID}`;
}

export function ModelsOverlay({ store }: ModelsOverlayProps): React.ReactNode {
    const snapshot = useStoreSnapshot(store);
    const slice = snapshot.modelsOverlay;
    const state: ModelsOverlayState = {
        leftEntries: slice.entries,
        roleRows: slice.roleRows,
        activeLeftIndex: slice.activeLeftIndex,
        activeRightIndex: slice.activeRightIndex,
        focusedColumn: slice.focusedColumn,
        searchQuery: slice.searchQuery,
        activeProviderTab: slice.activeProviderTab,
        pendingAssignModel: slice.pendingAssignModel,
    };
    const view = createModelsOverlayView(state, MODELS_OVERLAY_MAX_VISIBLE);

    useKeyboard((key) => {
        if (key.name === 'up') {
            key.preventDefault();
            store.navigateModelsOverlay(-1);
            return;
        }
        if (key.name === 'down') {
            key.preventDefault();
            store.navigateModelsOverlay(1);
            return;
        }
        if (key.name === 'left' || key.name === 'right') {
            key.preventDefault();
            const tabs = view.providerTabs;
            if (tabs.length <= 1) return;
            const currentIdx = tabs.findIndex((tab) => tab.id === slice.activeProviderTab);
            const safeIdx = currentIdx >= 0 ? currentIdx : 0;
            const delta = key.name === 'left' ? -1 : 1;
            const nextIdx = (safeIdx + delta + tabs.length) % tabs.length;
            const nextTab = tabs[nextIdx];
            if (nextTab !== undefined) {
                store.setModelsOverlayProviderTab(nextTab.id);
            }
            return;
        }
        if (key.name === 'tab') {
            key.preventDefault();
            if (slice.focusedColumn === 'right' && slice.pendingAssignModel !== null) {
                store.cancelPendingAssignment();
            }
            store.switchModelsOverlayColumn();
            return;
        }
        if (key.name === 'return') {
            if (slice.focusedColumn === 'left') {
                store.selectModelForAssignment();
            } else if (slice.pendingAssignModel !== null) {
                void store.confirmRoleAssignment();
            }
            return;
        }
        if (key.name === 'backspace' || key.name === 'delete') {
            if (slice.pendingAssignModel !== null) {
                store.cancelPendingAssignment();
                return;
            }
            if (slice.searchQuery.length > 0) {
                store.setModelsOverlaySearchQuery(slice.searchQuery.slice(0, -1));
                return;
            }
            const focusedRow = slice.roleRows[slice.activeRightIndex];
            if (focusedRow !== undefined) {
                void store.clearModelsOverlayRole(focusedRow.role);
            }
            return;
        }
        if (isSearchInputKey(key)) {
            store.setModelsOverlaySearchQuery(slice.searchQuery + key.name);
            return;
        }
        if (key.name === 'escape') {
            if (slice.pendingAssignModel !== null) {
                store.cancelPendingAssignment();
            } else {
                store.hideModelsOverlay();
            }
        }
    });

    const searchDisplay = slice.searchQuery.length > 0 ? slice.searchQuery : '(type to filter)';
    const hasPending = slice.pendingAssignModel !== null;
    const footer = hasPending
        ? '⏎ confirm assign · Tab/Esc/⌫ cancel · ↑↓ pick role'
        : '← → provider · type to search · ↑↓ navigate · Tab column · ⏎ assign · ⌫ clear · Esc close';

    return (
        <OverlayFrame variant="view" title="Models" hint="(Esc to close)" footer={footer}>
            <box flexDirection="row" marginTop={1}>
                {view.providerTabs.map((tab) => {
                    const isActive = tab.id === slice.activeProviderTab;
                    const marker = isActive ? '> ' : '  ';
                    return (
                        <text key={tab.id} {...(isActive ? { bg: SELECTED_BG } : { attributes: TextAttributes.DIM })}>
                            {`${marker}${tab.label} `}
                        </text>
                    );
                })}
            </box>
            <text {...(slice.searchQuery.length === 0 ? { attributes: TextAttributes.DIM } : {})}>
                {`Search: ${searchDisplay}`}
            </text>
            {view.totalLeft === 0 ? (
                <text attributes={TextAttributes.DIM}>No models match</text>
            ) : (
                <box flexDirection="row" marginTop={1}>
                    <box flexDirection="column" width="40%">
                        <text attributes={TextAttributes.BOLD}>{'Models'}</text>
                        <text attributes={TextAttributes.DIM}>
                            {`${view.startIndexLeft + 1}-${view.endIndexLeft + 1} of ${view.totalLeft}`}
                        </text>
                        {view.leftVisible.map((entry, index) => {
                            const globalIndex = view.startIndexLeft + index;
                            const isFocused = state.focusedColumn === 'left' && globalIndex === state.activeLeftIndex;
                            return (
                                <box
                                    key={`m-${entry.providerID}-${entry.modelID}-${entry.variantID ?? ''}`}
                                    flexDirection="row"
                                >
                                    <text {...(isFocused ? { bg: SELECTED_BG } : {})}>
                                        {`${isFocused ? '> ' : '  '}${formatSelection(entry)}`}
                                    </text>
                                </box>
                            );
                        })}
                    </box>
                    <box flexDirection="column" flexGrow={1}>
                        <text attributes={TextAttributes.BOLD}>{'Roles'}</text>
                        {hasPending && slice.pendingAssignModel !== null && (
                            <text fg="#ffff00" attributes={TextAttributes.BOLD}>
                                {`Assigning: ${formatSelection(slice.pendingAssignModel)}`}
                            </text>
                        )}
                        <text attributes={TextAttributes.DIM}>
                            {`${view.startIndexRight + 1}-${view.endIndexRight + 1} of ${view.totalRight}`}
                        </text>
                        {view.rightVisible.map((row: ModelsOverlayRoleRow, index) => {
                            const globalIndex = view.startIndexRight + index;
                            const isFocused = state.focusedColumn === 'right' && globalIndex === state.activeRightIndex;
                            const assignmentText =
                                row.assignment !== undefined
                                    ? formatSelection(row.assignment)
                                    : formatRoleFallback(row);
                            return (
                                <box key={`r-${row.role}`} flexDirection="row">
                                    <text {...(isFocused ? { bg: SELECTED_BG } : {})}>
                                        {`${isFocused ? '> ' : '  '}${padEndToDisplayWidth(row.role, 12)}`}
                                    </text>
                                    <text
                                        attributes={
                                            row.assignment !== undefined ? TextAttributes.BOLD : TextAttributes.DIM
                                        }
                                        {...(isFocused ? { bg: SELECTED_BG } : {})}
                                    >
                                        {assignmentText}
                                    </text>
                                </box>
                            );
                        })}
                    </box>
                </box>
            )}
        </OverlayFrame>
    );
}
