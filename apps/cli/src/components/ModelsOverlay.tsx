/** @jsxImportSource @opentui/react */

import type { ModelProviderSelection } from '@mission-control/protocol';
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type * as React from 'react';
import { useCallback, useSyncExternalStore } from 'react';
import type { ChatStore } from '../commands/chat-store.js';
import {
    createModelsOverlayView,
    formatRoleFallback,
    type ModelsOverlayRoleRow,
    type ModelsOverlayState,
} from '../commands/models-overlay-state.js';
import { OverlayFrame } from './OverlayFrame.js';
import { SELECTED_BG } from './overlay-theme.js';

const MODELS_OVERLAY_MAX_VISIBLE = 12;

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
        if (key.name === 'tab') {
            key.preventDefault();
            store.switchModelsOverlayColumn();
            return;
        }
        if (key.name === 'return') {
            const focusedModel = slice.entries[slice.activeLeftIndex];
            const focusedRow = slice.roleRows[slice.activeRightIndex];
            if (focusedModel !== undefined && focusedRow !== undefined) {
                void store.assignModelsOverlayRole(focusedRow.role, focusedModel);
            }
            return;
        }
        if (key.name === 'backspace' || key.name === 'delete') {
            const focusedRow = slice.roleRows[slice.activeRightIndex];
            if (focusedRow !== undefined) {
                void store.clearModelsOverlayRole(focusedRow.role);
            }
            return;
        }
        if (key.name === 'escape') {
            store.hideModelsOverlay();
        }
    });

    return (
        <OverlayFrame
            variant="view"
            title="Models"
            hint="(Esc to close)"
            footer="Up/Dn navigate · Tab switch column · Enter assign · Bksp/Del clear · Esc close"
        >
            {view.totalLeft === 0 ? (
                <text attributes={TextAttributes.DIM}>No models available</text>
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
                                        {`${isFocused ? '> ' : '  '}${row.role.padEnd(12)}`}
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
