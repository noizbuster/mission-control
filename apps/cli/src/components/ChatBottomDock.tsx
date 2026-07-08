/** @jsxImportSource @opentui/react */

import type { ScrollBoxRenderable, TextareaRenderable } from '@opentui/core';
import type * as React from 'react';
import { useRef, useSyncExternalStore } from 'react';
import { type ChatSelectorStore, createChatSelectorStore } from '../commands/chat-selector-store.js';
import type { ChatStore, ChatStoreState } from '../commands/chat-store.js';
import type { SlashCommandMenuState } from '../commands/interactive-chat-command-menu.js';
import type { FileAutocompleteState } from '../commands/interactive-chat-file-autocomplete.js';
import { resolveSeparatorState } from '../commands/separator-state.js';
import { DEFAULT_TERMINAL_VIEWPORT } from '../platform/terminal-viewport.js';
import { ChatInputArea } from './ChatInputArea.js';
import { type BottomDockMenuPolicy, bottomDockPolicy } from './chat-bottom-dock-policy.js';
import { FileAutocompletePanel } from './FileAutocompletePanel.js';
import { QuestionOverlay } from './OverlayPanels.js';
import { Separator, type SeparatorState } from './Separator.js';
import { SlashMenuPanel } from './SlashMenuPanel.js';
import { BottomStatusBar, type StatusBarLayout, type StatusBarProps, TopStatusBar } from './StatusBar.js';

export type ChatBottomDockSlice = {
    readonly inputMode: 'input' | 'question';
    readonly inputMirror: string;
    readonly menuState: SlashCommandMenuState;
    readonly workflowNames: readonly string[];
    readonly fileAutocomplete: FileAutocompleteState;
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
    readonly textareaRef: React.RefObject<TextareaRenderable | null>;
    readonly scrollboxRef: React.RefObject<ScrollBoxRenderable | null>;
    readonly inputFocused?: boolean;
    readonly viewportColumns?: number;
    readonly viewportRows?: number;
    readonly statusBarProps?: StatusBarProps;
    readonly statusLayout?: StatusBarLayout;
    readonly menuPolicy?: BottomDockMenuPolicy;
    readonly promptAdjacentPanel?: React.ReactNode;
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
    readonly promptAdjacentPanel: React.ReactNode | undefined;
};

const DEFAULT_MENU_POLICY = bottomDockPolicy({ columns: 80, rows: 24 }).menu;

export function selectChatBottomDockSlice(snapshot: ChatStoreState): ChatBottomDockSlice {
    return {
        inputMode: snapshot.overlayMode === 'question' ? 'question' : 'input',
        inputMirror: snapshot.inputMirror,
        menuState: snapshot.menuState,
        workflowNames: snapshot.workflowNames,
        fileAutocomplete: snapshot.fileAutocomplete,
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
}: PromptAdjacentPanelsInput): React.ReactNode {
    const showSlashOrWorkflow = dockSlice.inputMirror.startsWith('/') || dockSlice.inputMirror.startsWith('#');
    const showFileAutocomplete = !showSlashOrWorkflow && dockSlice.fileAutocomplete.open;
    const showPolicyMenu = menuPolicy.rows > 0 && (showSlashOrWorkflow || showFileAutocomplete);
    const hasPromptAdjacentPanel = promptAdjacentPanel !== undefined && promptAdjacentPanel !== null;

    if (!showPolicyMenu && !hasPromptAdjacentPanel) return null;

    return (
        <box flexDirection="column" flexShrink={0}>
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

export function ChatBottomDockBase({
    store,
    textareaRef,
    scrollboxRef,
    inputFocused = true,
    viewportColumns = DEFAULT_TERMINAL_VIEWPORT.columns,
    viewportRows = DEFAULT_TERMINAL_VIEWPORT.rows,
    statusBarProps,
    statusLayout,
    menuPolicy = DEFAULT_MENU_POLICY,
    promptAdjacentPanel,
    dockSlice,
}: ChatBottomDockBaseProps): React.ReactNode {
    const statusInput = { statusBarProps, statusLayout, dockSlice };
    const topStatusBarProps = buildTopStatusBarProps(statusInput);
    const bottomStatusBarProps = buildBottomStatusBarProps(statusInput);
    const promptPanels = renderPromptAdjacentPanels({ dockSlice, menuPolicy, promptAdjacentPanel });

    return (
        <box flexDirection="column" flexShrink={0}>
            {topStatusBarProps !== undefined ? <TopStatusBar {...topStatusBarProps} /> : null}
            {promptPanels}
            <Separator state={dockSlice.separatorState} width={Math.max(1, viewportColumns)} />
            {dockSlice.inputMode === 'question' ? (
                <QuestionOverlay store={store} />
            ) : (
                <ChatInputArea
                    store={store}
                    textareaRef={textareaRef}
                    scrollboxRef={scrollboxRef}
                    focused={inputFocused}
                    viewportRows={viewportRows}
                    promptMenuInteractionsEnabled={menuPolicy.rows > 0}
                />
            )}
            {bottomStatusBarProps !== undefined ? <BottomStatusBar {...bottomStatusBarProps} /> : null}
        </box>
    );
}

export function ChatBottomDock(props: ChatBottomDockProps): React.ReactNode {
    const selectorStoreRef = useRef<ChatSelectorStore<ChatBottomDockSlice> | null>(null);
    if (selectorStoreRef.current === null) {
        selectorStoreRef.current = createChatSelectorStore(props.store, selectChatBottomDockSlice);
    }
    const dockSlice = useSyncExternalStore(selectorStoreRef.current.subscribe, selectorStoreRef.current.getSnapshot);
    return <ChatBottomDockBase {...props} dockSlice={dockSlice} />;
}
