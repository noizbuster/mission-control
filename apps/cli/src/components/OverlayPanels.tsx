/** @jsxImportSource @opentui/react */
import { TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import type * as React from 'react';
import { useCallback, useSyncExternalStore } from 'react';
import { createProviderPromptView } from '../commands/auth-provider-keypress-view.js';
import {
    APPROVAL_LEVEL_PICKER_ENTRIES,
    APPROVAL_OPTIONS,
    type ChatStore,
    createSessionPickerView,
} from '../commands/chat-store.js';
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
        ? 'Up/Down to navigate, Space to toggle, Enter to submit, Esc to cancel'
        : 'Up/Down to navigate, Enter to select, Esc to cancel';

    return (
        <OverlayFrame
            variant="modal"
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
                            // biome-ignore lint/suspicious/noArrayIndexKey: question options are positional within a single overlay render
                            <box key={`q-opt-${index}-${option.label}`} flexDirection="column">
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
                                  <box flexDirection="row">
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
                return (
                    <text key={entry.sessionId} {...(isSelected ? { bg: SELECTED_BG } : {})}>
                        {isSelected ? '> ' : '  '}
                        {`${entry.sessionId}  ${entry.label}`}
                        {entry.updatedAt !== undefined ? `  (${entry.updatedAt})` : ''}
                    </text>
                );
            })}
        </OverlayFrame>
    );
}
