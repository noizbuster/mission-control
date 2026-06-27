/** @jsxImportSource @opentui/react */
import type { TextareaRenderable, ScrollBoxRenderable } from '@opentui/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { createRef } from 'react';
import type { OpenTuiChatBridge } from './chat-tui-types.js';
import type { ApprovalLevel } from './approval-level.js';
import { createChatStore, type ChatStore } from './chat-store.js';
import type { StatusBarProps } from '../components/StatusBar.js';

export type ChatTuiOptions = {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
    readonly sessionID?: string;
    readonly workspaceRoot?: string;
    readonly gitBranch?: string;
    readonly initialHistoryEntries?: readonly string[];
    readonly initialApprovalLevel?: ApprovalLevel;
};

/**
 * Internal factory that creates an {@link OpenTuiChatBridge} handle from an
 * already-constructed {@link ChatStore} and an unmount function. Splitting this
 * out from {@link createChatTui} makes the handle testable without mounting the
 * opentui renderer (no native FFI, no real terminal).
 */
export function createChatTuiHandle(store: ChatStore, unmountFn: () => void): OpenTuiChatBridge {
    return {
        waitForEvent: () => store.waitForEvent(),
        emitOutput: (text) => store.emitOutput(text),
        replaceOutputText: (text) => store.replaceOutputText(text),
        getOutput: () => store.getOutput(),
        showModelPicker: (choices) => store.showModelPicker(choices),
        showSessionPicker: (entries) => store.showSessionPicker(entries),
        showLevelPicker: (currentLevel?) => store.showLevelPicker(currentLevel),
        showApproval: (toolName, action) => store.showApproval(toolName, action),
        hideApproval: () => store.hideApproval(),
        showQuestion: (question, options, metadata?) => store.showQuestion(question, options, metadata),
        setGenerating: (value) => store.setGenerating(value),
        setAgentStatus: (text) => store.setAgentStatus(text),
        clearAgentStatus: () => store.clearAgentStatus(),
        isShowThinking: () => store.getSnapshot().showThinking,
        isToolOutputExpanded: () => store.getSnapshot().toolOutputExpanded,
        setWorkflowNames: (names) => store.setWorkflowNames(names),
        setModelCycleChoices: (choices) => store.setModelCycleChoices(choices),
        setApprovalLevel: (level) => store.setApprovalLevel(level),
        applyAbgOverlayPrefs: (prefs) => store.applyAbgOverlayPrefs(prefs),
        getAbgOverlayPrefsSnapshot: () => store.getAbgOverlayPrefsSnapshot(),
        get onModelCycleSelect(): ((selection: ModelProviderSelection) => void) | undefined {
            return store.onModelCycleSelect;
        },
        set onModelCycleSelect(value: ((selection: ModelProviderSelection) => void) | undefined) {
            store.onModelCycleSelect = value;
        },
        get onRenameSubmit(): ((name: string) => void) | undefined {
            return store.onRenameSubmit;
        },
        set onRenameSubmit(value: ((name: string) => void) | undefined) {
            store.onRenameSubmit = value;
        },
        unmount: unmountFn,
    };
}

/**
 * Full mount function: creates a {@link ChatStore}, dynamically imports the
 * opentui renderer + keymap provider + {@link ChatApp}, mounts the React tree,
 * and returns an {@link OpenTuiChatBridge} handle.
 *
 * Dynamic imports keep `@opentui/react`, the keymap provider, and `ChatApp` out
 * of the eager module graph so non-TUI CLI runs (plain / JSON) never load the
 * native renderer.
 */
export async function createChatTui(options: ChatTuiOptions): Promise<OpenTuiChatBridge> {
    const store = createChatStore({
        ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
        ...(options.initialHistoryEntries !== undefined
            ? { initialHistoryEntries: options.initialHistoryEntries }
            : {}),
        ...(options.initialApprovalLevel !== undefined
            ? { initialApprovalLevel: options.initialApprovalLevel }
            : {}),
    });

    const { useRenderer } = await import('@opentui/react');
    const { ChatKeymapProvider } = await import('../platform/keymap/keymap-provider.js');
    const { mountOpenTui } = await import('../platform/opentui-renderer.js');
    const { ChatApp } = await import('../components/ChatApp.js');

    const textareaRef = createRef<TextareaRenderable | null>();
    const scrollboxRef = createRef<ScrollBoxRenderable | null>();

    const statusBarProps: StatusBarProps = {
        providerID: options.providerID,
        modelID: options.modelID,
        ...(options.variantID !== undefined ? { variantID: options.variantID } : {}),
        ...(options.sessionID !== undefined ? { sessionID: options.sessionID } : {}),
        ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
        ...(options.gitBranch !== undefined ? { gitBranch: options.gitBranch } : {}),
    };

    const mountResult = await mountOpenTui(
        <ChatKeymapProvider useRenderer={useRenderer}>
            <ChatApp
                store={store}
                textareaRef={textareaRef}
                scrollboxRef={scrollboxRef}
                statusBarProps={statusBarProps}
            />
        </ChatKeymapProvider>,
    );

    return createChatTuiHandle(store, mountResult.unmount);
}
