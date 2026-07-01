/** @jsxImportSource @opentui/react */
// allow: SIZE_OK — collection of overlay components sharing the same imports,
// useStoreSnapshot helper, and opentui rendering context. Each overlay is a
// self-contained unit; splitting would duplicate the pragma + helper boilerplate.
import { resolveUserConfigDir } from '@mission-control/core';
import { MouseButton, type MouseEvent, TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type * as React from 'react';
import { useCallback, useState, useSyncExternalStore } from 'react';
import { toggleDisabled } from '../commands/agents-disabled-config.js';
import { parseModelPatternString, setOverride } from '../commands/agents-model-overrides-config.js';
import { createProviderPromptView } from '../commands/auth-provider-keypress-view.js';
import {
    APPROVAL_LEVEL_PICKER_ENTRIES,
    APPROVAL_OPTIONS,
    type ChatStore,
    createAgentsDashboardView,
    createSessionPickerView,
} from '../commands/chat-store.js';
import { loadDashboardAgentEntries } from '../commands/interactive-chat-actions.js';
import { OverlayFrame } from './OverlayFrame.js';
import { ACCENTS, SELECTED_BG } from './overlay-theme.js';

const MODEL_PICKER_MAX_VISIBLE = 10;

function useStoreSnapshot(store: ChatStore) {
    const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
    const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
    return useSyncExternalStore(subscribe, getSnapshot);
}

function isPrintableChar(key: { readonly name: string; readonly ctrl: boolean; readonly meta: boolean }): boolean {
    return !key.ctrl && !key.meta && key.name.length === 1;
}

// ---------------------------------------------------------------------------
// ApprovalOverlay
// ---------------------------------------------------------------------------

export type ApprovalOverlayProps = { readonly store: ChatStore };

export function ApprovalOverlay({ store }: ApprovalOverlayProps): React.ReactNode {
    const snapshot = useStoreSnapshot(store);

    useKeyboard((key) => {
        if (key.name === 'up') {
            key.preventDefault();
            store.navigateApproval(-1);
            return;
        }
        if (key.name === 'down') {
            key.preventDefault();
            store.navigateApproval(1);
            return;
        }
        if (key.name === 'return') {
            store.confirmApproval();
            return;
        }
        if (key.ctrl && key.name === 'c') {
            store.denyApproval();
            return;
        }
    });

    return (
        <OverlayFrame
            variant="modal"
            title="Approval Required"
            accent={ACCENTS.approval}
            footer="Up/Down to navigate, Enter to select, Ctrl+C to deny"
        >
            <box flexDirection="row">
                <text attributes={TextAttributes.BOLD}>Tool:</text>
                <text> {snapshot.approvalToolName}</text>
            </box>
            <text attributes={TextAttributes.DIM}>{snapshot.approvalAction}</text>
            <box flexDirection="column" marginTop={1}>
                {APPROVAL_OPTIONS.map((option, index) => {
                    const isSelected = index === snapshot.approvalSelectedIndex;
                    const selectedBg = isSelected ? { bg: SELECTED_BG } : {};
                    return (
                        <box key={option.key} flexDirection="row">
                            <text {...selectedBg}>
                                {isSelected ? '> ' : '  '}
                                {option.label}{' '}
                            </text>
                            <text attributes={TextAttributes.DIM} {...selectedBg}>
                                {option.description}
                            </text>
                        </box>
                    );
                })}
            </box>
        </OverlayFrame>
    );
}

// ---------------------------------------------------------------------------
// QuestionOverlay
// ---------------------------------------------------------------------------

export type QuestionOverlayProps = { readonly store: ChatStore };

export function QuestionOverlay({ store }: QuestionOverlayProps): React.ReactNode {
    const snapshot = useStoreSnapshot(store);

    useKeyboard((key) => {
        if (snapshot.questionCustomMode) {
            if (key.name === 'return') {
                store.resolveQuestion(snapshot.questionCustomBuffer);
                return;
            }
            if (key.name === 'escape') {
                store.exitQuestionCustomMode();
                return;
            }
            if (key.ctrl && key.name === 'c') {
                store.resolveQuestion('');
                store.sendInterrupt('ctrl-c');
                return;
            }
            if (key.name === 'backspace') {
                store.deleteQuestionCustomChar();
                return;
            }
            if (isPrintableChar(key)) {
                store.appendQuestionCustom(key.name);
                return;
            }
            return;
        }

        if (key.name === 'up') {
            key.preventDefault();
            store.navigateQuestion(-1);
            return;
        }
        if (key.name === 'down') {
            key.preventDefault();
            store.navigateQuestion(1);
            return;
        }
        if (key.name === 'return') {
            const customIndex = snapshot.questionOptions.length;
            if (snapshot.questionSelectedIndex === customIndex) {
                store.enterQuestionCustomMode();
                return;
            }
            if (snapshot.questionMultiple) {
                const selected = snapshot.questionOptions
                    .filter((_opt, i) => snapshot.questionSelectedIndices.has(i))
                    .map((opt) => opt.label);
                store.resolveQuestion(selected.join(', '));
                return;
            }
            const selected = snapshot.questionOptions[snapshot.questionSelectedIndex];
            store.resolveQuestion(selected?.label ?? '');
            return;
        }
        if (key.name === 'space' && snapshot.questionMultiple) {
            store.toggleQuestionOption();
            return;
        }
        if (key.name === 'escape') {
            // ESC cancels the question AND aborts the run. resolveQuestion
            // unblocks the ask_user tool (which is awaiting this promise); without
            // it, sendInterrupt could not be processed because the runner is
            // blocked on the same await.
            store.resolveQuestion('');
            store.sendInterrupt('esc');
            return;
        }
        if (key.ctrl && key.name === 'c') {
            store.resolveQuestion('');
            store.sendInterrupt('ctrl-c');
            return;
        }
    });

    const footerText = snapshot.questionMultiple
        ? 'Click or Up/Down + Space to toggle, Enter to submit, Esc to cancel'
        : 'Click or Up/Down + Enter to select, Esc to cancel';

    const onOptionClick = (index: number) => (event: MouseEvent) => {
        if (event.button !== MouseButton.LEFT) return;
        store.selectQuestionByClick(index);
    };

    return (
        <OverlayFrame
            variant="panel"
            title="Question"
            accent={ACCENTS.question}
            {...(snapshot.questionCustomMode ? {} : { footer: footerText })}
        >
            {snapshot.questionHeader.length > 0 ? (
                <text attributes={TextAttributes.BOLD}>{snapshot.questionHeader}</text>
            ) : null}
            <text>{snapshot.questionText}</text>
            {snapshot.questionCustomMode ? (
                <box marginTop={1}>
                    <box flexDirection="row">
                        <text fg="#ff00ff">{'>'}</text>
                        <text> {snapshot.questionCustomBuffer}</text>
                        <text bg="#ffffff" fg="#000000">
                            {'\u2588'}
                        </text>
                    </box>
                    <text attributes={TextAttributes.DIM}>
                        Enter to submit, Esc to go back to options, Ctrl+C to cancel
                    </text>
                </box>
            ) : (
                <box flexDirection="column" marginTop={1}>
                    {snapshot.questionOptions.map((option, index) => {
                        const isCursor = index === snapshot.questionSelectedIndex;
                        const prefix = snapshot.questionMultiple
                            ? `${snapshot.questionSelectedIndices.has(index) ? '[x] ' : '[ ] '}`
                            : '';
                        return (
                            // biome-ignore lint/a11y/noStaticElementInteractions: opentui <box> has no role concept; Up/Down/Enter/Space keyboard nav already exists, mouse is an enhancement
                            <box
                                key={`q-opt-${option.label}`}
                                flexDirection="column"
                                onMouseDown={onOptionClick(index)}
                            >
                                <text {...(isCursor ? { bg: SELECTED_BG } : {})}>
                                    {isCursor ? '> ' : '  '}
                                    {prefix}
                                    {option.label}
                                </text>
                                {option.description !== undefined ? (
                                    <text attributes={TextAttributes.DIM}>{`    ${option.description}`}</text>
                                ) : null}
                            </box>
                        );
                    })}
                    {snapshot.questionMultiple
                        ? null
                        : (() => {
                              const customIndex = snapshot.questionOptions.length;
                              const isSelected = customIndex === snapshot.questionSelectedIndex;
                              return (
                                  // biome-ignore lint/a11y/noStaticElementInteractions: opentui <box> has no role concept; Enter on this row already enters custom mode, mouse is an enhancement
                                  <box flexDirection="row" onMouseDown={onOptionClick(customIndex)}>
                                      <text {...(isSelected ? { bg: SELECTED_BG } : {})}>
                                          {isSelected ? '> ' : '  '}
                                      </text>
                                      <text
                                          attributes={TextAttributes.DIM}
                                          {...(isSelected ? { bg: SELECTED_BG } : {})}
                                      >
                                          Type custom answer...
                                      </text>
                                  </box>
                              );
                          })()}
                </box>
            )}
        </OverlayFrame>
    );
}

// ---------------------------------------------------------------------------
// ModelPickerOverlay
// ---------------------------------------------------------------------------

export type ModelPickerOverlayProps = { readonly store: ChatStore };

export function ModelPickerOverlay({ store }: ModelPickerOverlayProps): React.ReactNode {
    const snapshot = useStoreSnapshot(store);

    useKeyboard((key) => {
        if (key.name === 'return') {
            const promptChoices = snapshot.modelPickerChoices.map((choice) => ({
                id: choice.id,
                name: choice.label,
            }));
            const view = createProviderPromptView(
                snapshot.modelPickerKeypress,
                promptChoices,
                MODEL_PICKER_MAX_VISIBLE,
            );
            const selectedChoice = view.visibleChoices[view.selectedIndex - view.startIndex];
            if (selectedChoice !== undefined) {
                const modelChoice = snapshot.modelPickerChoices.find((c) => c.id === selectedChoice.id);
                store.hideModelPicker(modelChoice?.selection);
            }
            return;
        }
        if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
            store.hideModelPicker(undefined);
            return;
        }
        store.updateModelPickerKeypress(key.sequence);
    });

    const promptChoices = snapshot.modelPickerChoices.map((choice) => ({
        id: choice.id,
        name: choice.label,
    }));
    const view = createProviderPromptView(snapshot.modelPickerKeypress, promptChoices, MODEL_PICKER_MAX_VISIBLE);

    return (
        <OverlayFrame
            variant="modal"
            title="Select model"
            footer="Up/Down to navigate, type to search, Backspace to delete, Enter to select, Ctrl+C to cancel"
        >
            <text attributes={TextAttributes.DIM}>{`Search: ${view.searchQuery}`}</text>
            {view.totalCount === 0 ? (
                <text attributes={TextAttributes.DIM}>No models match</text>
            ) : (
                <text attributes={TextAttributes.DIM}>
                    {`Showing ${view.startIndex + 1}-${view.endIndex} of ${view.totalCount}`}
                </text>
            )}
            {view.visibleChoices.map((choice, index) => {
                const globalIndex = view.startIndex + index;
                const isSelected = globalIndex === view.selectedIndex;
                return (
                    <text key={choice.id} {...(isSelected ? { bg: SELECTED_BG } : {})}>
                        {isSelected ? '> ' : '  '}
                        {globalIndex + 1}. {choice.name}
                    </text>
                );
            })}
        </OverlayFrame>
    );
}

// ---------------------------------------------------------------------------
// LevelPickerOverlay
// ---------------------------------------------------------------------------

export type LevelPickerOverlayProps = { readonly store: ChatStore };

export function LevelPickerOverlay({ store }: LevelPickerOverlayProps): React.ReactNode {
    const snapshot = useStoreSnapshot(store);

    useKeyboard((key) => {
        if (key.name === 'up') {
            key.preventDefault();
            store.navigateLevelPicker(-1);
            return;
        }
        if (key.name === 'down') {
            key.preventDefault();
            store.navigateLevelPicker(1);
            return;
        }
        if (key.name === 'return') {
            const selected = APPROVAL_LEVEL_PICKER_ENTRIES[snapshot.levelPickerSelectedIndex];
            store.hideLevelPicker(selected?.id);
            return;
        }
        if (key.ctrl && key.name === 'c') {
            store.hideLevelPicker(undefined);
            return;
        }
    });

    return (
        <OverlayFrame
            variant="modal"
            title="Select approval level"
            footer="Up/Down to navigate, Enter to select, Ctrl+C to cancel"
        >
            {APPROVAL_LEVEL_PICKER_ENTRIES.map((level, index) => {
                const isSelected = index === snapshot.levelPickerSelectedIndex;
                return (
                    <box key={level.id} flexDirection="row">
                        <text {...(isSelected ? { bg: SELECTED_BG } : {})}>
                            {isSelected ? '> ' : '  '}
                            {level.label.padEnd(13)}
                        </text>
                        <text attributes={TextAttributes.DIM}>{level.desc}</text>
                    </box>
                );
            })}
        </OverlayFrame>
    );
}

// ---------------------------------------------------------------------------
// RenameOverlay
// ---------------------------------------------------------------------------

export type RenameOverlayProps = { readonly store: ChatStore };

export function RenameOverlay({ store }: RenameOverlayProps): React.ReactNode {
    const snapshot = useStoreSnapshot(store);

    useKeyboard((key) => {
        if (key.name === 'return') {
            store.submitRename(snapshot.renameBuffer);
            return;
        }
        if (key.name === 'escape') {
            store.cancelRename();
            return;
        }
        if (key.name === 'backspace') {
            store.deleteRenameChar();
            return;
        }
        if (isPrintableChar(key)) {
            store.appendRenameChar(key.name);
            return;
        }
    });

    return (
        <OverlayFrame variant="modal" title="Rename Session" footer="Enter to confirm, Esc to cancel">
            <text>Enter new session name:</text>
            <box flexDirection="row">
                <text fg="#00ffff">{'>'}</text>
                <text> {snapshot.renameBuffer}</text>
                <text bg="#ffffff" fg="#000000">
                    {'\u2588'}
                </text>
            </box>
        </OverlayFrame>
    );
}

// ---------------------------------------------------------------------------
// SessionPickerOverlay
// ---------------------------------------------------------------------------

export type SessionPickerOverlayProps = { readonly store: ChatStore };

export function SessionPickerOverlay({ store }: SessionPickerOverlayProps): React.ReactNode {
    const snapshot = useStoreSnapshot(store);

    useKeyboard((key) => {
        if (key.name === 'return') {
            store.confirmSessionPicker();
            return;
        }
        if ((key.ctrl && key.name === 'c') || key.name === 'escape') {
            store.cancelSessionPicker();
            return;
        }
        store.updateSessionPickerSearch(key.sequence);
    });

    const view = createSessionPickerView(
        snapshot.sessionPickerKeypress,
        snapshot.sessionPickerEntries,
        MODEL_PICKER_MAX_VISIBLE,
    );

    return (
        <OverlayFrame
            variant="modal"
            title="Select session"
            footer="Up/Down to navigate, type to search, Enter to attach, Ctrl+C to cancel"
        >
            <text attributes={TextAttributes.DIM}>{`Search: ${view.searchQuery}`}</text>
            {view.totalCount === 0 ? (
                <text attributes={TextAttributes.DIM}>No sessions match</text>
            ) : (
                <text attributes={TextAttributes.DIM}>
                    {`Showing ${view.startIndex + 1}-${view.endIndex} of ${view.totalCount}`}
                </text>
            )}
            {view.visibleEntries.map((entry, index) => {
                const globalIndex = view.startIndex + index;
                const isSelected = globalIndex === view.selectedIndex;
                const titleText = entry.label.length > 0 ? entry.label : entry.sessionId;
                const timestampText = entry.updatedAt ?? '';
                return (
                    <box key={entry.sessionId} flexDirection="row" {...(isSelected ? { bg: SELECTED_BG } : {})}>
                        <text>{isSelected ? '> ' : '  '}</text>
                        <text flexGrow={1}>{titleText}</text>
                        {timestampText.length > 0 ? <text attributes={TextAttributes.DIM}>{timestampText}</text> : null}
                    </box>
                );
            })}
        </OverlayFrame>
    );
}

// ---------------------------------------------------------------------------
// AgentsDashboardOverlay
// ---------------------------------------------------------------------------

const AGENTS_DASHBOARD_MAX_VISIBLE = 12;
const MODEL_OVERRIDE_PREVIEW = 'preview — active after task-spawn wiring lands';

export type AgentsDashboardOverlayProps = {
    readonly store: ChatStore;
    readonly workspaceRoot: string | undefined;
};

export function AgentsDashboardOverlay({ store, workspaceRoot }: AgentsDashboardOverlayProps): React.ReactNode {
    const snapshot = useStoreSnapshot(store);
    const [editBuffer, setEditBuffer] = useState('');
    const dashboard = snapshot.agentsDashboard;
    const view = createAgentsDashboardView(dashboard, AGENTS_DASHBOARD_MAX_VISIBLE);
    const isEditing = dashboard.editingName !== null;
    const inspector = view.inspectorEntry;

    useKeyboard((key) => {
        if (isEditing) {
            if (key.name === 'return') {
                const name = dashboard.editingName;
                if (name === null) return;
                const trimmed = editBuffer.trim();
                if (trimmed.length === 0) {
                    store.commitAgentsDashboardModelEdit(undefined);
                    if (workspaceRoot !== undefined) void setOverride({ workspaceRoot }, name, undefined);
                } else if (parseModelPatternString(trimmed) !== undefined) {
                    store.commitAgentsDashboardModelEdit(trimmed);
                    if (workspaceRoot !== undefined) void setOverride({ workspaceRoot }, name, trimmed);
                } else {
                    store.showTransientNotice('Invalid model format. Use provider/model[#variant]');
                    return;
                }
                setEditBuffer('');
                return;
            }
            if (key.name === 'escape') {
                store.cancelAgentsDashboardModelEdit();
                setEditBuffer('');
                return;
            }
            if (key.name === 'backspace') {
                setEditBuffer((prev) => prev.slice(0, -1));
                return;
            }
            if (isPrintableChar(key)) {
                setEditBuffer((prev) => prev + key.name);
                return;
            }
            return;
        }

        if (key.name === 'up' || key.name === 'k') {
            key.preventDefault();
            store.navigateAgentsDashboard(-1);
            return;
        }
        if (key.name === 'down' || key.name === 'j') {
            key.preventDefault();
            store.navigateAgentsDashboard(1);
            return;
        }
        if (key.name === 'tab' || key.name === 'right') {
            key.preventDefault();
            store.cycleAgentsDashboardSourceTab(key.shift ? -1 : 1);
            return;
        }
        if (key.name === 'left') {
            key.preventDefault();
            store.cycleAgentsDashboardSourceTab(-1);
            return;
        }
        if (key.name === 'space') {
            if (inspector !== null) {
                store.toggleAgentsDashboardAgentDisabled(inspector.name);
                if (workspaceRoot !== undefined) {
                    void toggleDisabled({ workspaceRoot }, inspector.name, inspector.disabled ? 'remove' : 'add');
                }
            }
            return;
        }
        if (key.name === 'return') {
            if (inspector !== null) {
                store.beginAgentsDashboardModelEdit(inspector.name);
                setEditBuffer(inspector.overrideModel ?? inspector.model ?? '');
            }
            return;
        }
        if (key.ctrl && key.name === 'r') {
            if (workspaceRoot !== undefined) {
                void (async () => {
                    const entries = await loadDashboardAgentEntries(workspaceRoot, resolveUserConfigDir());
                    store.reloadAgentsDashboard(entries);
                })();
            }
            return;
        }
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
            store.hideAgentsDashboard();
        }
    });

    return (
        <OverlayFrame
            variant="modal"
            title="Agents"
            footer="Up/Dn navigate · Tab cycle source · Space toggle · Enter edit · Ctrl+R reload · Esc close"
        >
            <box flexDirection="row">
                {view.sourceTabs.map((tab) => {
                    const active = tab.id === dashboard.sourceTab;
                    return (
                        <text key={tab.id} {...(active ? { attributes: TextAttributes.BOLD } : {})}>
                            {`${active ? '[' : ' '} ${tab.label} (${tab.count}) ${active ? ']' : ' '}`}
                        </text>
                    );
                })}
            </box>
            {view.totalCount === 0 ? (
                <text attributes={TextAttributes.DIM}>No agents discovered</text>
            ) : (
                <box flexDirection="row" marginTop={1}>
                    <box flexDirection="column" width="40%">
                        <text attributes={TextAttributes.DIM}>
                            {`${view.startIndex + 1}-${view.endIndex + 1} of ${view.totalCount}`}
                        </text>
                        {view.visibleEntries.map((entry, index) => {
                            const globalIndex = view.startIndex + index;
                            const isSelected = globalIndex === view.selectedIndex;
                            const marker = entry.disabled ? '\u2717' : entry.overrideModel !== undefined ? '*' : ' ';
                            return (
                                <box key={entry.name} flexDirection="row" {...(isSelected ? { bg: SELECTED_BG } : {})}>
                                    <text>
                                        {isSelected ? '> ' : '  '}
                                        {marker} {entry.name}
                                    </text>
                                </box>
                            );
                        })}
                    </box>
                    <box flexDirection="column" flexGrow={1}>
                        {inspector !== null ? (
                            <>
                                <text attributes={TextAttributes.BOLD}>{inspector.name}</text>
                                <text attributes={TextAttributes.DIM}>{inspector.description}</text>
                                <text>{`  Source: ${inspector.source}`}</text>
                                {inspector.model !== undefined ? <text>{`  Model: ${inspector.model}`}</text> : null}
                                {inspector.tier !== undefined ? <text>{`  Tier: ${inspector.tier}`}</text> : null}
                                {inspector.disabled ? <text fg="#ff6b6b">{'  Status: disabled'}</text> : null}
                                {isEditing ? (
                                    <box marginTop={1} flexDirection="column">
                                        <box flexDirection="row">
                                            <text fg="#00ffff">{'>'}</text>
                                            <text> {editBuffer}</text>
                                            <text bg="#ffffff" fg="#000000">
                                                {'\u2588'}
                                            </text>
                                        </box>
                                        <text attributes={TextAttributes.DIM}>{`  ${MODEL_OVERRIDE_PREVIEW}`}</text>
                                    </box>
                                ) : inspector.overrideModel !== undefined ? (
                                    <box flexDirection="column">
                                        <text fg="#ffaa00">{`  Override: ${inspector.overrideModel}`}</text>
                                        <text attributes={TextAttributes.DIM}>{`  ${MODEL_OVERRIDE_PREVIEW}`}</text>
                                    </box>
                                ) : null}
                                {inspector.filePath !== undefined ? (
                                    <text attributes={TextAttributes.DIM}>{`  File: ${inspector.filePath}`}</text>
                                ) : null}
                            </>
                        ) : null}
                    </box>
                </box>
            )}
        </OverlayFrame>
    );
}
