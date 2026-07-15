/** @jsxImportSource @opentui/solid */
// allow: SIZE_OK — collection of overlay components sharing the same imports.
import { resolveUserConfigDir } from '@mission-control/core';
import { padEndToDisplayWidth } from '@mission-control/tui';
import { MouseButton, type MouseEvent, TextAttributes } from '@opentui/core';
import { useKeyboard } from '@opentui/solid';
import { createMemo, createSignal, For, type JSX, Show } from 'solid-js';
import { useSolidStoreSelector } from '../platform/use-solid-store-selector';
import { createProviderPromptView } from '../state/auth-provider-keypress-view';
import type { ChatAppActions } from '../state/chat-app-actions';
import {
    APPROVAL_LEVEL_PICKER_ENTRIES,
    APPROVAL_OPTIONS,
    type ChatStore,
    createAgentsDashboardView,
    createSessionPickerView,
} from '../state/chat-store';
import { OverlayFrame } from './OverlayFrame';
import { printableCharFromKey } from './overlay-key-input';
import {
    ACCENTS,
    LEFT_ACCENT_BORDER,
    OVERLAY_PANEL_BG,
    QUESTION_CURSOR,
    QUESTION_CURSOR_FG,
    QUESTION_SELECTED_FG,
    SELECTED_BG,
} from './overlay-theme';

const MODEL_PICKER_MAX_VISIBLE = 10;



// ---------------------------------------------------------------------------
// ApprovalOverlay
// ---------------------------------------------------------------------------

export type ApprovalOverlayProps = { readonly store: ChatStore };

export function ApprovalOverlay({ store }: ApprovalOverlayProps): JSX.Element {
    const snapshot = useSolidStoreSelector(store, (snapshot) => snapshot);

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
                <text> {snapshot().approvalToolName}</text>
            </box>
            <text attributes={TextAttributes.DIM}>{snapshot().approvalAction}</text>
            <box flexDirection="column" marginTop={1}>
                <For each={APPROVAL_OPTIONS}>
                    {(option, index) => {
                        const isSelected = index() === snapshot().approvalSelectedIndex;
                        const selectedBg = isSelected ? { bg: SELECTED_BG } : {};
                        return (
                            <box flexDirection="row">
                                <text {...selectedBg}>
                                    {isSelected ? '> ' : '  '}
                                    {option.label}{' '}
                                </text>
                                <text attributes={TextAttributes.DIM} {...selectedBg}>
                                    {option.description}
                                </text>
                            </box>
                        );
                    }}
                </For>
            </box>
        </OverlayFrame>
    );
}

// ---------------------------------------------------------------------------
// QuestionOverlay
// ---------------------------------------------------------------------------

export type QuestionOverlayProps = { readonly store: ChatStore };

export function QuestionOverlay({ store }: QuestionOverlayProps): JSX.Element {
    const snapshot = useSolidStoreSelector(store, (snapshot) => snapshot);

    const multiBatch = createMemo(
        () =>
            snapshot().questionTabs.length > 1 ||
            (snapshot().questionTabs.length === 1 && (snapshot().questionTabs[0]?.multiple ?? false)),
    );

    useKeyboard((key) => {
        if (snapshot().questionCustomMode) {
            if (key.name === 'return') {
                store.submitCustomAnswer(snapshot().questionCustomBuffer);
                return;
            }
            if (key.name === 'escape') {
                store.exitQuestionCustomMode();
                return;
            }
            if (key.ctrl && key.name === 'c') {
                store.rejectQuestion();
                store.sendInterrupt('ctrl-c');
                return;
            }
            if (key.name === 'backspace') {
                store.deleteQuestionCustomChar();
                return;
            }
            const ch = printableCharFromKey(key);
            if (ch !== undefined) {
                store.appendQuestionCustom(ch);
            }
            return;
        }

        if (snapshot().questionConfirmActive) {
            if (key.name === 'return') {
                store.confirmQuestionBatch();
                return;
            }
            if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
                store.rejectQuestion();
                store.sendInterrupt(key.ctrl ? 'ctrl-c' : 'esc');
            }
            return;
        }

        if (multiBatch() && (key.name === 'left' || key.name === 'h')) {
            store.navigateQuestionTab(-1);
            return;
        }
        if (multiBatch() && (key.name === 'right' || key.name === 'l' || key.name === 'tab')) {
            store.navigateQuestionTab(1);
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
            const customIndex = snapshot().questionOptions.length;
            if (snapshot().questionSelectedIndex === customIndex) {
                store.enterQuestionCustomMode();
                return;
            }
            // Batch: Enter picks (single → record + advance) or toggles (multi).
            if (snapshot().questionTabs.length > 0) {
                if (snapshot().questionMultiple) {
                    store.toggleQuestionOption();
                } else {
                    store.selectQuestionByClick(snapshot().questionSelectedIndex);
                }
                return;
            }
            if (snapshot().questionMultiple) {
                const selected = snapshot()
                    .questionOptions.filter((_opt, i) => snapshot().questionSelectedIndices.has(i))
                    .map((opt) => opt.label);
                store.resolveQuestion(selected.join(', '));
                return;
            }
            const selected = snapshot().questionOptions[snapshot().questionSelectedIndex];
            store.resolveQuestion(selected?.label ?? '');
            return;
        }
        if (key.name === 'space' && snapshot().questionMultiple) {
            store.toggleQuestionOption();
            return;
        }
        if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
            // ESC/Ctrl+C cancels the question AND aborts the run. rejectQuestion
            // unblocks the ask_user await; without it sendInterrupt could not be
            // processed because the runner is blocked on that same await.
            store.rejectQuestion();
            store.sendInterrupt(key.ctrl ? 'ctrl-c' : 'esc');
        }
    });

    const footerText = createMemo(() =>
        snapshot().questionConfirmActive
            ? 'Enter to submit answers, Esc to cancel'
            : multiBatch()
              ? '\u2190/\u2192 or Tab switch question \u00b7 Up/Dn + Enter to answer \u00b7 Esc cancel'
              : snapshot().questionMultiple
                ? 'Click or hover + Up/Dn, Space to toggle, Enter to submit, Esc to cancel'
                : 'Click or hover + Up/Dn + Enter to select, Esc to cancel',
    );

    const onOptionClick = (index: number) => (event: MouseEvent) => {
        if (event.button !== MouseButton.LEFT) return;
        store.selectQuestionByClick(index);
    };
    const onOptionHover = (index: number) => (): void => store.hoverQuestion(index);
    const onTabHover = (index: number) => (): void => store.hoverQuestionTab(index);

    // Each text line is wrapped in its own <box>: opentui merges adjacent
    // <text> siblings onto one row, which is what jumbled the old layout.
    return (
        <box
            flexShrink={0}
            flexDirection="column"
            border={['left']}
            borderColor={ACCENTS.question}
            customBorderChars={LEFT_ACCENT_BORDER}
            backgroundColor={OVERLAY_PANEL_BG}
            paddingLeft={1}
            paddingRight={1}
        >
            <box height={1}>
                <text fg={ACCENTS.question} attributes={TextAttributes.BOLD}>
                    {multiBatch()
                        ? ` Question (${snapshot().questionTabIndex + 1}/${snapshot().questionTabs.length}) `
                        : ' Question '}
                </text>
            </box>
            {multiBatch() && !snapshot().questionCustomMode ? (
                <box height={1}>
                    <box flexDirection="row">
                        <For each={snapshot().questionTabs}>
                            {(tab, index) => {
                                const isActive = index() === snapshot().questionTabIndex;
                                const isAnswered = (snapshot().questionAnswers[index()]?.length ?? 0) > 0;
                                const tabBg = isActive ? { backgroundColor: ACCENTS.question } : {};
                                return (
                                    // biome-ignore lint/a11y/noStaticElementInteractions: opentui <box> has no role concept; Left/Right/Tab nav already exists, mouse is an enhancement
                                    <box paddingLeft={1} paddingRight={1} onMouseOver={onTabHover(index())} {...tabBg}>
                                        <text
                                            {...(isActive
                                                ? { fg: '#000000' }
                                                : isAnswered
                                                  ? {}
                                                  : { attributes: TextAttributes.DIM })}
                                        >
                                            {`${index() + 1}. ${tab.header.length > 0 ? tab.header : tab.question.slice(0, 20)}`}
                                        </text>
                                    </box>
                                );
                            }}
                        </For>
                        {/* biome-ignore lint/a11y/noStaticElementInteractions: opentui <box> has no role concept; Left/Right/Tab nav already exists, mouse is an enhancement */}
                        <box
                            paddingLeft={1}
                            paddingRight={1}
                            onMouseOver={onTabHover(snapshot().questionTabs.length)}
                            {...(snapshot().questionConfirmActive ? { backgroundColor: ACCENTS.question } : {})}
                        >
                            <text
                                {...(snapshot().questionConfirmActive
                                    ? { fg: '#000000' }
                                    : { attributes: TextAttributes.DIM })}
                            >
                                Confirm
                            </text>
                        </box>
                    </box>
                </box>
            ) : null}
            {snapshot().questionConfirmActive ? (
                <box flexDirection="column" marginTop={1}>
                    <box height={1}>
                        <text attributes={TextAttributes.BOLD}>Review your answers</text>
                    </box>
                    <For each={snapshot().questionTabs}>
                        {(tab, index) => {
                            const value = snapshot().questionAnswers[index()]?.join(', ') ?? '';
                            const answered = value.length > 0;
                            return (
                                <box flexDirection="row" paddingLeft={1}>
                                    <text
                                        attributes={TextAttributes.DIM}
                                    >{`${tab.header.length > 0 ? tab.header : tab.question}: `}</text>
                                    <text fg={answered ? QUESTION_SELECTED_FG : '#ff6b6b'}>
                                        {answered ? value : '(not answered)'}
                                    </text>
                                </box>
                            );
                        }}
                    </For>
                </box>
            ) : snapshot().questionHeader.length > 0 ? (
                <box height={1}>
                    <text attributes={TextAttributes.BOLD}>{snapshot().questionHeader}</text>
                </box>
            ) : null}
            {snapshot().questionConfirmActive ? null : (
                <box>
                    <text>{snapshot().questionText}</text>
                </box>
            )}
            {snapshot().questionConfirmActive ? null : snapshot().questionCustomMode ? (
                <box marginTop={1}>
                    <box flexDirection="row">
                        <text fg="#ff00ff">{'>'}</text>
                        <text> {snapshot().questionCustomBuffer}</text>
                        <text bg="#ffffff" fg="#000000">
                            {'\u2588'}
                        </text>
                    </box>
                    <box height={1}>
                        <text attributes={TextAttributes.DIM}>
                            Enter to submit, Esc to go back to options, Ctrl+C to cancel
                        </text>
                    </box>
                </box>
            ) : (
                <box flexDirection="column" marginTop={1}>
                    <For each={snapshot().questionOptions}>
                        {(option, index) => {
                            const isCursor = index() === snapshot().questionSelectedIndex;
                            const marker = snapshot().questionMultiple
                                ? `${snapshot().questionSelectedIndices.has(index()) ? '[x] ' : '[ ] '}`
                                : `${index() + 1}. `;
                            const rowBg = isCursor ? { backgroundColor: SELECTED_BG } : {};
                            const labelStyle = isCursor
                                ? { fg: QUESTION_SELECTED_FG, attributes: TextAttributes.BOLD }
                                : {};
                            const descStyle = isCursor
                                ? { fg: QUESTION_SELECTED_FG }
                                : { attributes: TextAttributes.DIM };
                            return (
                                // biome-ignore lint/a11y/noStaticElementInteractions: opentui <box> has no role concept; Up/Down/Enter/Space keyboard nav already exists, mouse is an enhancement
                                <box
                                    flexDirection="column"
                                    onMouseDown={onOptionClick(index())}
                                    onMouseOver={onOptionHover(index())}
                                    {...rowBg}
                                >
                                    <box flexDirection="row">
                                        <text {...(isCursor ? { fg: QUESTION_CURSOR_FG } : {})}>
                                            {isCursor ? `${QUESTION_CURSOR} ` : '  '}
                                        </text>
                                        <text {...labelStyle}>{`${marker}${option.label}`}</text>
                                    </box>
                                    {option.description !== undefined ? (
                                        <box flexDirection="row" paddingLeft={2}>
                                            <text {...descStyle}>{option.description}</text>
                                        </box>
                                    ) : null}
                                </box>
                            );
                        }}
                    </For>
                    {snapshot().questionMultiple
                        ? null
                        : (() => {
                              const customIndex = snapshot().questionOptions.length;
                              const isSelected = customIndex === snapshot().questionSelectedIndex;
                              const rowBg = isSelected ? { backgroundColor: SELECTED_BG } : {};
                              return (
                                  // biome-ignore lint/a11y/noStaticElementInteractions: opentui <box> has no role concept; Enter on this row already enters custom mode, mouse is an enhancement
                                  <box
                                      flexDirection="column"
                                      onMouseDown={onOptionClick(customIndex)}
                                      onMouseOver={onOptionHover(customIndex)}
                                      {...rowBg}
                                  >
                                      <box flexDirection="row">
                                          <text {...(isSelected ? { fg: QUESTION_CURSOR_FG } : {})}>
                                              {isSelected ? `${QUESTION_CURSOR} ` : '  '}
                                          </text>
                                          <text
                                              {...(isSelected
                                                  ? { fg: QUESTION_SELECTED_FG }
                                                  : { attributes: TextAttributes.DIM })}
                                          >
                                              {`${customIndex + 1}. Type custom answer...`}
                                          </text>
                                      </box>
                                  </box>
                              );
                          })()}
                </box>
            )}
            {snapshot().questionCustomMode ? null : (
                <box height={1} marginTop={1}>
                    <text attributes={TextAttributes.DIM}>{footerText()}</text>
                </box>
            )}
        </box>
    );
}

// ---------------------------------------------------------------------------
// ModelPickerOverlay
// ---------------------------------------------------------------------------

export type ModelPickerOverlayProps = { readonly store: ChatStore };

export function ModelPickerOverlay({ store }: ModelPickerOverlayProps): JSX.Element {
    const snapshot = useSolidStoreSelector(store, (snapshot) => snapshot);
    const promptChoices = createMemo(() =>
        snapshot().modelPickerChoices.map((choice) => ({
            id: choice.id,
            name: choice.label,
        })),
    );
    const view = createMemo(() =>
        createProviderPromptView(snapshot().modelPickerKeypress, promptChoices(), MODEL_PICKER_MAX_VISIBLE),
    );

    useKeyboard((key) => {
        if (key.name === 'return') {
            const currentView = view();
            const selectedChoice = currentView.visibleChoices[currentView.selectedIndex - currentView.startIndex];
            if (selectedChoice !== undefined) {
                const modelChoice = snapshot().modelPickerChoices.find((c) => c.id === selectedChoice.id);
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

    return (
        <OverlayFrame
            variant="modal"
            title="Select model"
            footer="Up/Down to navigate, type to search, Backspace to delete, Enter to select, Ctrl+C to cancel"
        >
            <text attributes={TextAttributes.DIM}>{`Search: ${view().searchQuery}`}</text>
            {view().totalCount === 0 ? (
                <text attributes={TextAttributes.DIM}>No models match</text>
            ) : (
                <text attributes={TextAttributes.DIM}>
                    {`Showing ${view().startIndex + 1}-${view().endIndex} of ${view().totalCount}`}
                </text>
            )}
            <For each={view().visibleChoices}>
                {(choice, index) => {
                    const globalIndex = view().startIndex + index();
                    const isSelected = globalIndex === view().selectedIndex;
                    return (
                        <text {...(isSelected ? { bg: SELECTED_BG } : {})}>
                            {isSelected ? '> ' : '  '}
                            {globalIndex + 1}. {choice.name}
                        </text>
                    );
                }}
            </For>
        </OverlayFrame>
    );
}

// ---------------------------------------------------------------------------
// LevelPickerOverlay
// ---------------------------------------------------------------------------

export type LevelPickerOverlayProps = { readonly store: ChatStore };

export function LevelPickerOverlay({ store }: LevelPickerOverlayProps): JSX.Element {
    const snapshot = useSolidStoreSelector(store, (snapshot) => snapshot);

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
            const selected = APPROVAL_LEVEL_PICKER_ENTRIES[snapshot().levelPickerSelectedIndex];
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
            <For each={APPROVAL_LEVEL_PICKER_ENTRIES}>
                {(level, index) => {
                    const isSelected = index() === snapshot().levelPickerSelectedIndex;
                    return (
                        <box flexDirection="row">
                            <text {...(isSelected ? { bg: SELECTED_BG } : {})}>
                                {isSelected ? '> ' : '  '}
                                {padEndToDisplayWidth(level.label, 13)}
                            </text>
                            <text attributes={TextAttributes.DIM}>{level.desc}</text>
                        </box>
                    );
                }}
            </For>
        </OverlayFrame>
    );
}

// ---------------------------------------------------------------------------
// RenameOverlay
// ---------------------------------------------------------------------------

export type RenameOverlayProps = { readonly store: ChatStore };

export function RenameOverlay({ store }: RenameOverlayProps): JSX.Element {
    const snapshot = useSolidStoreSelector(store, (snapshot) => snapshot);

    useKeyboard((key) => {
        if (key.name === 'return') {
            store.submitRename(snapshot().renameBuffer);
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
        {
            const ch = printableCharFromKey(key);
            if (ch !== undefined) {
                store.appendRenameChar(ch);
                return;
            }
        }
    });

    return (
        <OverlayFrame variant="modal" title="Rename Session" footer="Enter to confirm, Esc to cancel">
            <text>Enter new session name:</text>
            <box flexDirection="row">
                <text fg="#00ffff">{'>'}</text>
                <text> {snapshot().renameBuffer}</text>
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

export function SessionPickerOverlay({ store }: SessionPickerOverlayProps): JSX.Element {
    const snapshot = useSolidStoreSelector(store, (snapshot) => snapshot);
    const view = createMemo(() =>
        createSessionPickerView(
            snapshot().sessionPickerKeypress,
            snapshot().sessionPickerEntries,
            MODEL_PICKER_MAX_VISIBLE,
        ),
    );

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

    return (
        <OverlayFrame
            variant="modal"
            title="Select session"
            footer="Up/Down to navigate, type to search, Enter to attach, Ctrl+C to cancel"
        >
            <text attributes={TextAttributes.DIM}>{`Search: ${view().searchQuery}`}</text>
            {view().totalCount === 0 ? (
                <text attributes={TextAttributes.DIM}>No sessions match</text>
            ) : (
                <text attributes={TextAttributes.DIM}>
                    {`Showing ${view().startIndex + 1}-${view().endIndex} of ${view().totalCount}`}
                </text>
            )}
            <For each={view().visibleEntries}>
                {(entry, index) => {
                    const globalIndex = view().startIndex + index();
                    const isSelected = globalIndex === view().selectedIndex;
                    const titleText = entry.label.length > 0 ? entry.label : entry.sessionId;
                    const timestampText = entry.updatedAt ?? '';
                    return (
                        <box flexDirection="row" {...(isSelected ? { bg: SELECTED_BG } : {})}>
                            <text>{isSelected ? '> ' : '  '}</text>
                            <text flexGrow={1}>{titleText}</text>
                            {timestampText.length > 0 ? (
                                <text attributes={TextAttributes.DIM}>{timestampText}</text>
                            ) : null}
                        </box>
                    );
                }}
            </For>
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
    readonly actions?: ChatAppActions;
};

export function AgentsDashboardOverlay({ store, workspaceRoot, actions }: AgentsDashboardOverlayProps): JSX.Element {
    const snapshot = useSolidStoreSelector(store, (snapshot) => snapshot);
    const [editBuffer, setEditBuffer] = createSignal('');
    const dashboard = createMemo(() => snapshot().agentsDashboard);
    const view = createMemo(() => createAgentsDashboardView(dashboard(), AGENTS_DASHBOARD_MAX_VISIBLE));
    const isEditing = createMemo(() => dashboard().editingName !== null);
    const inspector = createMemo(() => view().inspectorEntry);

    useKeyboard((key) => {
        if (isEditing()) {
            if (key.name === 'return') {
                const name = dashboard().editingName;
                if (name === null) return;
                const trimmed = editBuffer().trim();
                if (trimmed.length === 0) {
                    store.commitAgentsDashboardModelEdit(undefined);
                    if (workspaceRoot !== undefined)
                        void actions?.setAgentModelOverride?.(workspaceRoot, name, undefined);
                } else if (actions?.isValidModelPattern?.(trimmed) === true) {
                    store.commitAgentsDashboardModelEdit(trimmed);
                    if (workspaceRoot !== undefined)
                        void actions?.setAgentModelOverride?.(workspaceRoot, name, trimmed);
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
            {
                const ch = printableCharFromKey(key);
                if (ch !== undefined) {
                    setEditBuffer((prev) => prev + ch);
                    return;
                }
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
            const currentInspector = inspector();
            if (currentInspector !== null) {
                store.toggleAgentsDashboardAgentDisabled(currentInspector.name);
                if (workspaceRoot !== undefined) {
                    void actions?.toggleAgentDisabled?.(
                        workspaceRoot,
                        currentInspector.name,
                        currentInspector.disabled ? 'remove' : 'add',
                    );
                }
            }
            return;
        }
        if (key.name === 'return') {
            const currentInspector = inspector();
            if (currentInspector !== null) {
                store.beginAgentsDashboardModelEdit(currentInspector.name);
                setEditBuffer(currentInspector.overrideModel ?? currentInspector.model ?? '');
            }
            return;
        }
        if (key.ctrl && key.name === 'r') {
            if (workspaceRoot !== undefined) {
                const loader = actions?.loadDashboardAgentEntries;
                if (loader !== undefined) {
                    void (async () => {
                        const entries = await loader(workspaceRoot, resolveUserConfigDir());
                        store.reloadAgentsDashboard(entries);
                    })();
                }
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
                <For each={view().sourceTabs}>
                    {(tab) => {
                        const active = tab.id === dashboard().sourceTab;
                        return (
                            <text {...(active ? { attributes: TextAttributes.BOLD } : {})}>
                                {`${active ? '[' : ' '} ${tab.label} (${tab.count}) ${active ? ']' : ' '}`}
                            </text>
                        );
                    }}
                </For>
            </box>
            {view().totalCount === 0 ? (
                <text attributes={TextAttributes.DIM}>No agents discovered</text>
            ) : (
                <box flexDirection="row" marginTop={1}>
                    <box flexDirection="column" width="40%">
                        <text attributes={TextAttributes.DIM}>
                            {`${view().startIndex + 1}-${view().endIndex + 1} of ${view().totalCount}`}
                        </text>
                        <For each={view().visibleEntries}>
                            {(entry, index) => {
                                const globalIndex = view().startIndex + index();
                                const isSelected = globalIndex === view().selectedIndex;
                                const marker = entry.disabled
                                    ? '\u2717'
                                    : entry.overrideModel !== undefined
                                      ? '*'
                                      : ' ';
                                return (
                                    <box flexDirection="row" {...(isSelected ? { bg: SELECTED_BG } : {})}>
                                        <text>
                                            {isSelected ? '> ' : '  '}
                                            {marker} {entry.name}
                                        </text>
                                    </box>
                                );
                            }}
                        </For>
                    </box>
                    <box flexDirection="column" flexGrow={1}>
                        <Show when={inspector()}>
                            {(entry) => (
                                <>
                                    <text attributes={TextAttributes.BOLD}>{entry().name}</text>
                                    <text attributes={TextAttributes.DIM}>{entry().description}</text>
                                    <text>{`  Source: ${entry().source}`}</text>
                                    {entry().model !== undefined ? <text>{`  Model: ${entry().model}`}</text> : null}
                                    {entry().tier !== undefined ? <text>{`  Tier: ${entry().tier}`}</text> : null}
                                    {entry().disabled ? <text fg="#ff6b6b">{'  Status: disabled'}</text> : null}
                                    {isEditing() ? (
                                        <box marginTop={1} flexDirection="column">
                                            <box flexDirection="row">
                                                <text fg="#00ffff">{'>'}</text>
                                                <text> {editBuffer()}</text>
                                                <text bg="#ffffff" fg="#000000">
                                                    {'\u2588'}
                                                </text>
                                            </box>
                                            <text attributes={TextAttributes.DIM}>{`  ${MODEL_OVERRIDE_PREVIEW}`}</text>
                                        </box>
                                    ) : entry().overrideModel !== undefined ? (
                                        <box flexDirection="column">
                                            <text fg="#ffaa00">{`  Override: ${entry().overrideModel}`}</text>
                                            <text attributes={TextAttributes.DIM}>{`  ${MODEL_OVERRIDE_PREVIEW}`}</text>
                                        </box>
                                    ) : null}
                                    {entry().filePath !== undefined ? (
                                        <text attributes={TextAttributes.DIM}>{`  File: ${entry().filePath}`}</text>
                                    ) : null}
                                </>
                            )}
                        </Show>
                    </box>
                </box>
            )}
        </OverlayFrame>
    );
}
