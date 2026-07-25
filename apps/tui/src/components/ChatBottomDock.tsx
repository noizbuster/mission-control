/** @jsxImportSource @opentui/solid */

import type { TuiSkillMenuEntry } from '@mission-control/protocol';
import { useTerminalDimensions } from '@opentui/solid';
import { type JSX, Show } from 'solid-js';
import { AgentSpinner } from '../app/AgentSpinner';
import { useSolidStoreSelector } from '../platform/use-solid-store-selector';
import type { ChatAppActions } from '../state/chat-app-actions';
import type { ChatStore, ChatStoreState } from '../state/chat-store';
import type { HistoryPickerEntry, HistoryPickerState } from '../state/history-picker-state';
import type { SlashCommandMenuState } from '../state/interactive-chat-command-menu';
import type { FileAutocompleteState } from '../state/interactive-chat-file-autocomplete';
import { resolveSeparatorState } from '../state/separator-state';
import { ChatInputArea } from './ChatInputArea';
import type { ChatTextareaHandle } from './ChatInputTextarea';
import type { ChatScrollboxHandle } from './ChatTranscript';
import { type BottomDockMenuPolicy, bottomDockPolicy } from './chat-bottom-dock-policy';
import { FileAutocompletePanel } from './FileAutocompletePanel';
import { HistoryPickerPanel } from './HistoryPickerPanel';
import { QuestionOverlay } from './OverlayPanels';
import type { SeparatorState } from './Separator';
import { SlashMenuPanel } from './SlashMenuPanel';
import {
    BottomStatusBar,
    type StatusBarLayout,
    type StatusBarProps,
    statusBarLayoutFromPolicy,
    TopStatusBar,
} from './StatusBar';

export type ChatBottomDockSlice = {
    readonly inputMode: 'input' | 'question';
    readonly inputMirror: string;
    readonly menuState: SlashCommandMenuState;
    readonly workflowNames: readonly string[];
    readonly skillEntries: readonly TuiSkillMenuEntry[];
    readonly fileAutocomplete: FileAutocompleteState;
    readonly historyEntries: readonly HistoryPickerEntry[];
    readonly historyPicker: HistoryPickerState;
    readonly providerID: string | undefined;
    readonly modelID: string | undefined;
    readonly variantID: string | undefined;
    readonly contextTokensUsed: number | undefined;
    readonly contextTokensMax: number | undefined;
    readonly contextCacheUsage: ChatStoreState['contextCacheUsage'];
    readonly sessionId: string;
    readonly approvalLevel: ChatStoreState['approvalLevel'];
    readonly separatorState: SeparatorState;
    readonly generating: boolean;
    readonly agentStatusText: string;
    readonly agentRetryAt: number | undefined;
};

export type ChatBottomDockProps = {
    readonly store: ChatStore;
    readonly textareaRef: ChatTextareaHandle;
    readonly scrollboxRef: ChatScrollboxHandle;
    readonly inputFocused?: boolean;
    readonly statusBarProps?: StatusBarProps;
    readonly promptAdjacentPanel?: JSX.Element;
    readonly actions?: ChatAppActions;
};

export type ChatBottomDockBaseProps = ChatBottomDockProps & {
    readonly dockSlice: ChatBottomDockSlice;
};

type StatusPropsInput = {
    readonly statusBarProps: StatusBarProps | undefined;
    readonly statusLayout: StatusBarLayout | undefined;
    readonly dockSlice: ChatBottomDockSlice;
};

type PromptAdjacentPanelsInput = {
    readonly dockSlice: ChatBottomDockSlice;
    readonly menuPolicy: BottomDockMenuPolicy;
    readonly promptAdjacentPanel: JSX.Element | undefined;
};

export function selectChatBottomDockSlice(snapshot: ChatStoreState): ChatBottomDockSlice {
    return {
        inputMode: snapshot.overlayMode === 'question' ? 'question' : 'input',
        inputMirror: snapshot.inputMirror,
        menuState: snapshot.menuState,
        workflowNames: snapshot.workflowNames,
        skillEntries: snapshot.skillEntries,
        fileAutocomplete: snapshot.fileAutocomplete,
        historyEntries: snapshot.historyEntries,
        historyPicker: snapshot.historyPicker,
        providerID: snapshot.currentModelSelection?.providerID,
        modelID: snapshot.currentModelSelection?.modelID,
        variantID: snapshot.currentModelVariantID,
        contextTokensUsed: snapshot.contextTokensUsed,
        contextTokensMax: snapshot.contextTokensMax,
        contextCacheUsage: snapshot.contextCacheUsage,
        sessionId: snapshot.sessionId,
        approvalLevel: snapshot.approvalLevel,
        separatorState: resolveSeparatorState({
            generating: snapshot.generating,
            approvalActive: snapshot.overlayMode === 'approval',
            questionActive: snapshot.overlayMode === 'question',
        }),
        generating: snapshot.generating,
        agentStatusText: snapshot.agentStatusText,
        agentRetryAt: snapshot.agentRetryAt,
    };
}

/** True when dock-visible fields are unchanged (ignores transcript `outputText` publishes). */
export function chatBottomDockSliceEqual(left: ChatBottomDockSlice, right: ChatBottomDockSlice): boolean {
    return (
        left.inputMode === right.inputMode &&
        left.inputMirror === right.inputMirror &&
        left.menuState === right.menuState &&
        left.workflowNames === right.workflowNames &&
        left.skillEntries === right.skillEntries &&
        left.fileAutocomplete === right.fileAutocomplete &&
        left.historyEntries === right.historyEntries &&
        left.historyPicker === right.historyPicker &&
        left.providerID === right.providerID &&
        left.modelID === right.modelID &&
        left.variantID === right.variantID &&
        left.contextTokensUsed === right.contextTokensUsed &&
        left.contextTokensMax === right.contextTokensMax &&
        left.contextCacheUsage === right.contextCacheUsage &&
        left.sessionId === right.sessionId &&
        left.approvalLevel === right.approvalLevel &&
        left.separatorState === right.separatorState &&
        left.generating === right.generating &&
        left.agentStatusText === right.agentStatusText &&
        left.agentRetryAt === right.agentRetryAt
    );
}

/**
 * Selector that keeps a stable slice reference across transcript stream publishes.
 * Without this, every 50ms `emitOutput` rebuilds a new dock slice object and forces
 * bottom-dock layout work that resizes the transcript viewport (visible flicker).
 */
export function createStableChatBottomDockSelector(): (snapshot: ChatStoreState) => ChatBottomDockSlice {
    let previous: ChatBottomDockSlice | undefined;
    return (snapshot: ChatStoreState): ChatBottomDockSlice => {
        const next = selectChatBottomDockSlice(snapshot);
        if (previous !== undefined && chatBottomDockSliceEqual(previous, next)) {
            return previous;
        }
        previous = next;
        return next;
    };
}

function renderPromptAdjacentPanels({
    dockSlice,
    menuPolicy,
    promptAdjacentPanel,
    columns,
}: PromptAdjacentPanelsInput & { readonly columns: number }): JSX.Element | null {
    const historyPickerOpen = dockSlice.historyPicker.open;
    const showHistoryPicker = historyPickerOpen && menuPolicy.rows > 0;
    const showSlashWorkflowOrSkill =
        !historyPickerOpen &&
        (dockSlice.inputMirror.startsWith('/') ||
            dockSlice.inputMirror.startsWith('#') ||
            dockSlice.inputMirror.startsWith('$'));
    const showFileAutocomplete = !historyPickerOpen && !showSlashWorkflowOrSkill && dockSlice.fileAutocomplete.open;
    const showPolicyMenu = menuPolicy.rows > 0 && (showSlashWorkflowOrSkill || showFileAutocomplete);
    const hasPromptAdjacentPanel = promptAdjacentPanel !== undefined && promptAdjacentPanel !== null;

    if (!showHistoryPicker && !showPolicyMenu && !hasPromptAdjacentPanel) return null;

    return (
        <box flexDirection="column" flexShrink={0} width="100%">
            {showHistoryPicker ? (
                <HistoryPickerPanel
                    entries={[...dockSlice.historyEntries].reverse()}
                    pickerState={dockSlice.historyPicker}
                    maxLines={menuPolicy.rows}
                    viewportColumns={columns}
                    showFooter={menuPolicy.showPanelFooter}
                />
            ) : null}
            {showPolicyMenu && showSlashWorkflowOrSkill ? (
                <SlashMenuPanel
                    inputBuffer={dockSlice.inputMirror}
                    menuState={dockSlice.menuState}
                    workflowNames={dockSlice.workflowNames}
                    skillEntries={dockSlice.skillEntries}
                    maxVisibleRows={menuPolicy.rows}
                    viewportColumns={columns}
                    showFooter={menuPolicy.showPanelFooter}
                />
            ) : null}
            {showPolicyMenu && showFileAutocomplete ? (
                <FileAutocompletePanel
                    fileAutocomplete={dockSlice.fileAutocomplete}
                    maxVisibleRows={menuPolicy.rows}
                    showFooter={menuPolicy.showPanelFooter}
                    viewportColumns={columns}
                />
            ) : null}
            {promptAdjacentPanel ?? null}
        </box>
    );
}

export function buildTopStatusBarProps(input: StatusPropsInput): StatusBarProps | undefined {
    if (input.statusBarProps === undefined) {
        return undefined;
    }
    return {
        ...input.statusBarProps,
        ...(input.statusLayout !== undefined ? { statusLayout: input.statusLayout } : {}),
        ...(input.dockSlice.providerID !== undefined ? { providerID: input.dockSlice.providerID } : {}),
        ...(input.dockSlice.modelID !== undefined ? { modelID: input.dockSlice.modelID } : {}),
        ...(input.dockSlice.variantID !== undefined ? { variantID: input.dockSlice.variantID } : {}),
        ...(input.dockSlice.contextTokensUsed !== undefined
            ? { contextTokensUsed: input.dockSlice.contextTokensUsed }
            : {}),
        ...(input.dockSlice.contextTokensMax !== undefined
            ? { contextTokensMax: input.dockSlice.contextTokensMax }
            : {}),
        ...(input.dockSlice.contextCacheUsage !== undefined
            ? {
                  contextCacheInputTokens: input.dockSlice.contextCacheUsage.inputTokens,
                  contextCacheReadTokens: input.dockSlice.contextCacheUsage.cacheReadTokens,
              }
            : {}),
    };
}

export function buildBottomStatusBarProps(input: StatusPropsInput): StatusBarProps | undefined {
    if (input.statusBarProps === undefined) {
        return undefined;
    }
    return {
        ...input.statusBarProps,
        ...(input.statusLayout !== undefined ? { statusLayout: input.statusLayout } : {}),
        ...(input.dockSlice.sessionId.length > 0 ? { sessionID: input.dockSlice.sessionId } : {}),
        ...(input.dockSlice.approvalLevel !== undefined ? { approvalLevel: input.dockSlice.approvalLevel } : {}),
    };
}

export function ChatBottomDockBase(props: ChatBottomDockBaseProps): JSX.Element {
    const dimensions = useTerminalDimensions();
    const dockPolicyValue = () =>
        bottomDockPolicy({
            columns: dimensions().width,
            rows: dimensions().height,
        });
    const statusLayout = () => statusBarLayoutFromPolicy(dockPolicyValue());
    const menuPolicy = (): BottomDockMenuPolicy => dockPolicyValue().menu;
    const topStatusBarProps = () =>
        buildTopStatusBarProps({
            statusBarProps: props.statusBarProps,
            statusLayout: statusLayout(),
            dockSlice: props.dockSlice,
        });
    const bottomStatusBarProps = () =>
        buildBottomStatusBarProps({
            statusBarProps: props.statusBarProps,
            statusLayout: statusLayout(),
            dockSlice: props.dockSlice,
        });

    const agentStatusLine = (): string | undefined => {
        if (props.dockSlice.agentStatusText.length > 0) return props.dockSlice.agentStatusText;
        if (props.dockSlice.generating) return 'Working…';
        return undefined;
    };

    return (
        <box flexDirection="column" flexShrink={0} width="100%">
            <Show when={agentStatusLine()}>
                {(text) => <AgentSpinner text={text()} retryAt={props.dockSlice.agentRetryAt} />}
            </Show>
            <Show when={topStatusBarProps()}>{(top) => <TopStatusBar {...top()} />}</Show>
            {renderPromptAdjacentPanels({
                dockSlice: props.dockSlice,
                menuPolicy: menuPolicy(),
                promptAdjacentPanel: props.promptAdjacentPanel,
                columns: dimensions().width,
            })}
            <Show
                when={props.dockSlice.inputMode === 'question'}
                fallback={
                    <ChatInputArea
                        store={props.store}
                        textareaRef={props.textareaRef}
                        scrollboxRef={props.scrollboxRef}
                        focused={props.inputFocused ?? true}
                        viewportRows={dimensions().height}
                        promptMenuInteractionsEnabled={menuPolicy().rows > 0}
                        {...(props.actions !== undefined ? { actions: props.actions } : {})}
                    />
                }
            >
                <QuestionOverlay store={props.store} />
            </Show>
            <Show when={bottomStatusBarProps()}>{(bottom) => <BottomStatusBar {...bottom()} />}</Show>
        </box>
    );
}

export function ChatBottomDock(props: ChatBottomDockProps): JSX.Element {
    const selectDockSlice = createStableChatBottomDockSelector();
    const dockSlice = useSolidStoreSelector(props.store, selectDockSlice);
    return (
        <ChatBottomDockBase
            store={props.store}
            textareaRef={props.textareaRef}
            scrollboxRef={props.scrollboxRef}
            dockSlice={dockSlice()}
            {...(props.inputFocused !== undefined ? { inputFocused: props.inputFocused } : {})}
            {...(props.statusBarProps !== undefined ? { statusBarProps: props.statusBarProps } : {})}
            {...(props.promptAdjacentPanel !== undefined ? { promptAdjacentPanel: props.promptAdjacentPanel } : {})}
            {...(props.actions !== undefined ? { actions: props.actions } : {})}
        />
    );
}
