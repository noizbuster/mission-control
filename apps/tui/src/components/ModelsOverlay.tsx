/** @jsxImportSource @opentui/solid */

import { getModelContextLimit } from '@mission-control/config';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { padEndToDisplayWidth } from '@mission-control/tui';
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/solid';
import { createMemo, For, type JSX, Show } from 'solid-js';
import { useTuiLocalPreferences } from '../platform/providers/local-preferences-context';
import { useSolidStoreSelector } from '../platform/use-solid-store-selector';
import type { ChatStore } from '../state/chat-store';
import {
    createModelsOverlayView,
    formatRoleFallback,
    type ModelsOverlayRoleRow,
    type ModelsOverlayState,
} from '../state/models-overlay-state';
import { buildModelContextPrefLines } from './model-context-pref-lines';
import { OverlayFrame } from './OverlayFrame';
import { printableCharFromKey } from './overlay-key-input';
import { SELECTED_BG } from './overlay-theme';

const MODELS_OVERLAY_MAX_VISIBLE = 12;

export type ModelsOverlayProps = { readonly store: ChatStore };

function formatSelection(selection: ModelProviderSelection): string {
    return selection.variantID !== undefined
        ? `${selection.providerID}/${selection.modelID}#${selection.variantID}`
        : `${selection.providerID}/${selection.modelID}`;
}

export function ModelsOverlay({ store }: ModelsOverlayProps): JSX.Element {
    const localPreferences = useTuiLocalPreferences();
    const slice = useSolidStoreSelector(store, (snapshot) => snapshot.modelsOverlay);
    const state = createMemo<ModelsOverlayState>(() => ({
        leftEntries: slice().entries,
        roleRows: slice().roleRows,
        activeLeftIndex: slice().activeLeftIndex,
        activeRightIndex: slice().activeRightIndex,
        focusedColumn: slice().focusedColumn,
        searchQuery: slice().searchQuery,
        activeProviderTab: slice().activeProviderTab,
        pendingAssignModel: slice().pendingAssignModel,
    }));
    const view = createMemo(() => createModelsOverlayView(state(), MODELS_OVERLAY_MAX_VISIBLE));
    const focusedSelection = createMemo((): ModelProviderSelection | undefined => {
        if (slice().focusedColumn === 'left') {
            const offset = view().activeLeftIndex - view().startIndexLeft;
            return view().leftVisible[offset];
        }
        const roleRow = slice().roleRows[view().activeRightIndex];
        return roleRow?.assignment ?? roleRow?.fallback;
    });
    const prefLines = createMemo(() => {
        const selection = focusedSelection();
        if (selection === undefined) return undefined;
        return buildModelContextPrefLines(selection, localPreferences.preferences().modelContextPrefs);
    });
    // Key-repeat guard for dismiss vs in-flight role assign (separate latches).
    let dismissSettled = false;
    let assignSettled = false;
    useKeyboard((key) => {
        if (dismissSettled) return;
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
            if (key.shift) {
                const selection = focusedSelection();
                if (selection === undefined) return;
                if (store.isEventQueueClosed() || store.getSnapshot().overlayMode !== 'models-overlay') return;
                const catalogDefault = getModelContextLimit(selection.providerID, selection.modelID);
                void localPreferences
                    .stepModelContextLimit(selection, key.name === 'left' ? -1 : 1, catalogDefault)
                    .then(() => {
                        if (store.isEventQueueClosed() || store.getSnapshot().overlayMode !== 'models-overlay') {
                            return;
                        }
                        const live = store.getSnapshot().currentModelSelection;
                        if (
                            live === undefined ||
                            live.providerID !== selection.providerID ||
                            live.modelID !== selection.modelID
                        ) {
                            return;
                        }
                        const lines = buildModelContextPrefLines(
                            selection,
                            localPreferences.preferences().modelContextPrefs,
                        );
                        store.setContextTokensMaxFromStep(lines.effectiveContextLimit);
                    })
                    .catch(() => undefined);
                return;
            }
            if (key.ctrl) {
                const selection = focusedSelection();
                if (selection === undefined) return;
                if (store.isEventQueueClosed() || store.getSnapshot().overlayMode !== 'models-overlay') return;
                void localPreferences
                    .stepModelAutoCompactThreshold(selection, key.name === 'left' ? -1 : 1)
                    .catch(() => undefined);
                return;
            }
            const tabs = view().providerTabs;
            if (tabs.length <= 1) return;
            const currentIdx = tabs.findIndex((tab) => tab.id === slice().activeProviderTab);
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
            if (slice().focusedColumn === 'right' && slice().pendingAssignModel !== null) {
                store.cancelPendingAssignment();
            }
            store.switchModelsOverlayColumn();
            return;
        }
        if (key.name === 'return') {
            if (slice().focusedColumn === 'left') {
                store.selectModelForAssignment();
            } else if (slice().pendingAssignModel !== null) {
                // Key-repeat can double-fire async role assign.
                if (assignSettled) return;
                assignSettled = true;
                void store
                    .confirmRoleAssignment()
                    .catch(() => undefined)
                    .finally(() => {
                        assignSettled = false;
                    });
            }
            return;
        }
        if (key.name === 'backspace' || key.name === 'delete') {
            if (slice().pendingAssignModel !== null) {
                store.cancelPendingAssignment();
                return;
            }
            if (slice().searchQuery.length > 0) {
                store.setModelsOverlaySearchQuery(slice().searchQuery.slice(0, -1));
                return;
            }
            const focusedRow = slice().roleRows[slice().activeRightIndex];
            if (focusedRow !== undefined) {
                if (assignSettled) return;
                assignSettled = true;
                void store
                    .clearModelsOverlayRole(focusedRow.role)
                    .catch(() => undefined)
                    .finally(() => {
                        assignSettled = false;
                    });
            }
            return;
        }
        const character = printableCharFromKey(key);
        if (character !== undefined) {
            key.preventDefault();
            store.setModelsOverlaySearchQuery(slice().searchQuery + character);
            return;
        }
        if (key.name === 'escape') {
            if (slice().pendingAssignModel !== null) {
                store.cancelPendingAssignment();
                return;
            }
            dismissSettled = true;
            store.hideModelsOverlay();
        }
    });

    const searchDisplay = createMemo(() => (slice().searchQuery.length > 0 ? slice().searchQuery : '(type to filter)'));
    const hasPending = createMemo(() => slice().pendingAssignModel !== null);
    const footer = createMemo(() =>
        hasPending()
            ? '⏎ confirm assign · Tab/Esc/⌫ cancel · ↑↓ pick role'
            : '← → provider · Shift+←→ context · Ctrl+←→ compact · type search · ↑↓ · Tab · ⏎ assign · Esc',
    );

    return (
        <OverlayFrame variant="view" title="Models" hint="(Esc to close)" footer={footer()}>
            <box flexDirection="row" marginTop={1}>
                <For each={view().providerTabs}>
                    {(tab) => {
                        const isActive = createMemo(() => tab.id === slice().activeProviderTab);
                        return (
                            <text {...(isActive() ? { bg: SELECTED_BG } : { attributes: TextAttributes.DIM })}>
                                {`${isActive() ? '> ' : '  '}${tab.label} `}
                            </text>
                        );
                    }}
                </For>
            </box>
            <text {...(slice().searchQuery.length === 0 ? { attributes: TextAttributes.DIM } : {})}>
                {`Search: ${searchDisplay()}`}
            </text>
            <Show when={prefLines()}>
                {(lines) => (
                    <box flexDirection="column" marginTop={1}>
                        <text attributes={TextAttributes.DIM}>{lines().contextLine}</text>
                        <text attributes={TextAttributes.DIM}>{lines().compactLine}</text>
                    </box>
                )}
            </Show>
            {view().totalLeft === 0 ? (
                <text attributes={TextAttributes.DIM}>No models match</text>
            ) : (
                <box flexDirection="row" marginTop={1}>
                    <box flexDirection="column" width="40%">
                        <text attributes={TextAttributes.BOLD}>{'Models'}</text>
                        <text attributes={TextAttributes.DIM}>
                            {`${view().startIndexLeft + 1}-${view().endIndexLeft + 1} of ${view().totalLeft}`}
                        </text>
                        <For each={view().leftVisible}>
                            {(entry, index) => {
                                const isFocused = createMemo(
                                    () =>
                                        state().focusedColumn === 'left' &&
                                        view().startIndexLeft + index() === state().activeLeftIndex,
                                );
                                return (
                                    <box flexDirection="row">
                                        <text {...(isFocused() ? { bg: SELECTED_BG } : {})}>
                                            {`${isFocused() ? '> ' : '  '}${formatSelection(entry)}`}
                                        </text>
                                    </box>
                                );
                            }}
                        </For>
                    </box>
                    <box flexDirection="column" flexGrow={1}>
                        <text attributes={TextAttributes.BOLD}>{'Roles'}</text>
                        <Show when={slice().pendingAssignModel}>
                            {(pendingAssignModel) => (
                                <text fg="#ffff00" attributes={TextAttributes.BOLD}>
                                    {`Assigning: ${formatSelection(pendingAssignModel())}`}
                                </text>
                            )}
                        </Show>
                        <text attributes={TextAttributes.DIM}>
                            {`${view().startIndexRight + 1}-${view().endIndexRight + 1} of ${view().totalRight}`}
                        </text>
                        <For each={view().rightVisible}>
                            {(row: ModelsOverlayRoleRow, index) => {
                                const isFocused = createMemo(
                                    () =>
                                        state().focusedColumn === 'right' &&
                                        view().startIndexRight + index() === state().activeRightIndex,
                                );
                                return (
                                    <box flexDirection="row">
                                        <text {...(isFocused() ? { bg: SELECTED_BG } : {})}>
                                            {`${isFocused() ? '> ' : '  '}${padEndToDisplayWidth(row.role, 12)}`}
                                        </text>
                                        <text
                                            attributes={
                                                row.assignment !== undefined ? TextAttributes.BOLD : TextAttributes.DIM
                                            }
                                            {...(isFocused() ? { bg: SELECTED_BG } : {})}
                                        >
                                            {row.assignment !== undefined
                                                ? formatSelection(row.assignment)
                                                : formatRoleFallback(row)}
                                        </text>
                                    </box>
                                );
                            }}
                        </For>
                    </box>
                </box>
            )}
        </OverlayFrame>
    );
}
