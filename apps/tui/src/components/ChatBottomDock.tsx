/** @jsxImportSource @opentui/solid */

import { useTerminalDimensions } from '@opentui/solid';
import { type JSX, Show } from 'solid-js';
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
    readonly fileAutocomplete: FileAutocompleteState;
    readonly historyEntries: readonly HistoryPickerEntry[];
    readonly historyPicker: HistoryPickerState;
    readonly providerID: string | undefined;
    readonly modelID: string | undefined;
    readonly variantID: string | undefined;
    readonly contextTokensUsed: number | undefined;
    readonly contextTokensMax: number | undefined;
    readonly sessionId: string;
    readonly approvalLevel: ChatStoreState['approvalLevel'];
    readonly separatorState: SeparatorState;
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
        fileAutocomplete: snapshot.fileAutocomplete,
        historyEntries: snapshot.historyEntries,
        historyPicker: snapshot.historyPicker,
        providerID: snapshot.currentModelSelection?.providerID,
        modelID: snapshot.currentModelSelection?.modelID,
        variantID: snapshot.currentModelVariantID,
        contextTokensUsed: snapshot.contextTokensUsed,
        contextTokensMax: snapshot.contextTokensMax,
        sessionId: snapshot.sessionId,
        approvalLevel: snapshot.approvalLevel,
        separatorState: resolveSeparatorState({
            generating: snapshot.generating,
            approvalActive: snapshot.overlayMode === 'approval',
            questionActive: snapshot.overlayMode === 'question',
        }),
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
    const showSlashOrWorkflow =
        !historyPickerOpen && (dockSlice.inputMirror.startsWith('/') || dockSlice.inputMirror.startsWith('#'));
    const showFileAutocomplete = !historyPickerOpen && !showSlashOrWorkflow && dockSlice.fileAutocomplete.open;
    const showPolicyMenu = menuPolicy.rows > 0 && (showSlashOrWorkflow || showFileAutocomplete);
    const hasPromptAdjacentPanel = promptAdjacentPanel !== undefined && promptAdjacentPanel !== null;

    if (!showHistoryPicker && !showPolicyMenu && !hasPromptAdjacentPanel) return null;

    return (
        <box flexDirection="column" flexShrink={0} width="100%">
            {showHistoryPicker ? (
                <HistoryPickerPanel
                    entries={[...dockSlice.historyEntries].reverse()}
                    pickerState={dockSlice.historyPicker}
                    maxLines={menuPolicy.rows}
                    columns={columns}
                    showFooter={menuPolicy.showPanelFooter}
                />
            ) : null}
            {showPolicyMenu && showSlashOrWorkflow ? (
                <SlashMenuPanel
                    inputBuffer={dockSlice.inputMirror}
                    menuState={dockSlice.menuState}
                    workflowNames={dockSlice.workflowNames}
                    maxVisibleRows={menuPolicy.rows}
                    showFooter={menuPolicy.showPanelFooter}
                />
            ) : null}
            {showPolicyMenu && showFileAutocomplete ? (
                <FileAutocompletePanel
                    fileAutocomplete={dockSlice.fileAutocomplete}
                    maxVisibleRows={menuPolicy.rows}
                    showFooter={menuPolicy.showPanelFooter}
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

    return (
        <box flexDirection="column" flexShrink={0} width="100%">
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
    const dockSlice = useSolidStoreSelector(props.store, selectChatBottomDockSlice);
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
