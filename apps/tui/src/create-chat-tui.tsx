import { getModelContextLimit } from '@mission-control/config';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { ChatTuiHandle, ChatTuiRuntimeOptions } from './state/chat-tui-types';
import type { ModelsOverlayRoleRow } from './state/index';
import { type ChatStore, createChatStore } from './state/index';

export type ChatTuiOptions = ChatTuiRuntimeOptions;

/**
 * Internal factory that creates a {@link ChatTuiHandle} from an
 * already-constructed {@link ChatStore} and an unmount function. Splitting this
 * out from {@link createChatTui} makes the handle testable without mounting the
 * opentui renderer (no native FFI, no real terminal).
 */
export function createChatTuiHandle(store: ChatStore, unmountFn: () => void): ChatTuiHandle {
    let unmounted = false;
    return {
        waitForEvent: () => store.waitForEvent(),
        emitOutput: (text) => store.emitOutput(text),
        emitTranscriptPart: (part, fallbackText) => store.emitTranscriptPart(part, fallbackText),
        emitTranscriptFallback: (text) => store.emitTranscriptFallback(text),
        replaceOutputText: (text) => store.replaceOutputText(text),
        replaceTranscript: (parts, outputText) => store.replaceTranscript(parts, outputText),
        getOutput: () => store.getOutput(),
        showModelPicker: (choices) => store.showModelPicker(choices),
        showSessionPicker: (entries) => store.showSessionPicker(entries),
        showAgentsDashboard: (entries) => store.showAgentsDashboard(entries),
        reloadAgentsDashboard: (entries) => store.reloadAgentsDashboard(entries),
        hideAgentsDashboard: () => store.hideAgentsDashboard(),
        showMissionPanel: (rows) => store.showMissionPanel(rows),
        reloadMissions: (rows) => store.reloadMissions(rows),
        hideMissionPanel: () => store.hideMissionPanel(),
        showModelsOverlay: (entries: readonly ModelProviderSelection[], roleRows: readonly ModelsOverlayRoleRow[]) =>
            store.showModelsOverlay(entries, roleRows),
        showLevelPicker: (currentLevel?) => store.showLevelPicker(currentLevel),
        showApproval: (toolName, action) => store.showApproval(toolName, action),
        hideApproval: () => store.hideApproval(),
        showQuestion: (question, options, metadata?) => store.showQuestion(question, options, metadata),
        showQuestionBatch: (entries) => store.showQuestionBatch(entries),
        setGenerating: (value) => store.setGenerating(value),
        setAgentStatus: (text) => store.setAgentStatus(text),
        setAgentRetryStatus: (text, retryAt) => store.setAgentRetryStatus(text, retryAt),
        clearAgentStatus: () => store.clearAgentStatus(),
        showTransientNotice: (text) => store.showTransientNotice(text),
        setStickyNotice: (message) => store.setStickyNotice(message),
        isShowThinking: () => store.getSnapshot().showThinking,
        isToolOutputExpanded: () => store.getSnapshot().toolOutputExpanded,
        setWorkflowNames: (names) => store.setWorkflowNames(names),
        setSkillNames: (names) => store.setSkillNames(names),
        setModelCycleChoices: (choices) => store.setModelCycleChoices(choices),
        setModelSelection: (selection) => store.setModelSelection(selection),
        setApprovalLevel: (level) => store.setApprovalLevel(level),
        setSessionId: (id) => store.setSessionId(id),
        setSessionDisplayName: (name) => store.setSessionDisplayName(name),
        setContextTokensUsed: (used) => store.setContextTokensUsed(used),
        setContextTokensMax: (max) => store.setContextTokensMax(max),
        setContextCacheUsage: (usage) => store.setContextCacheUsage(usage),
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
        unmount: () => {
            if (unmounted) return;
            unmounted = true;
            store.closeEventQueue();
            unmountFn();
        },
    };
}

/**
 * Full mount function: creates a {@link ChatStore}, dynamically imports the
 * opentui renderer + provider root + {@link App}, mounts the Solid tree,
 * and returns a {@link ChatTuiHandle}.
 *
 * Dynamic imports keep `@opentui/solid`, the provider root, and `App` out
 * of the eager module graph so non-TUI CLI runs (plain / JSON) never load the
 * native renderer.
 */
export async function createChatTui(options: ChatTuiOptions): Promise<ChatTuiHandle> {
    const store = createChatStore({
        ...(options.workspaceRoot !== undefined ? { workspaceRoot: options.workspaceRoot } : {}),
        ...(options.initialHistoryEntries !== undefined
            ? { initialHistoryEntries: options.initialHistoryEntries }
            : {}),
        ...(options.initialApprovalLevel !== undefined ? { initialApprovalLevel: options.initialApprovalLevel } : {}),
        ...(options.authStore !== undefined ? { authStore: options.authStore } : {}),
    });
    store.setContextTokensMax(getModelContextLimit(options.providerID, options.modelID));
    // Seed currentModelSelection so Ctrl+V variant cycling works pre-`/model`.
    store.setModelSelection({
        providerID: options.providerID,
        modelID: options.modelID,
        ...(options.variantID !== undefined ? { variantID: options.variantID } : {}),
    });
    void import('@mission-control/core').then(async ({ TuiStores }) => {
        const prefs = await new TuiStores.TuiLocalPreferencesStore().getPreferences();
        const { resolveEffectiveContextLimit } = await import('@mission-control/config');
        store.setContextTokensMax(
            resolveEffectiveContextLimit(
                { providerID: options.providerID, modelID: options.modelID },
                prefs.modelContextPrefs,
            ),
        );
    });

    const { useRenderer } = await import('@opentui/solid');
    const { mountOpenTui } = await import('@mission-control/tui/opentui-renderer');
    const { bootstrapTreeSitter } = await import('./platform/tree-sitter-bootstrap');
    const { App } = await import('@mission-control/tui/app');
    const { createComponent } = await import('solid-js');
    const { MissionControlTuiProviders } = await import('@mission-control/tui/providers');
    const { closeTreeSitterClient, destroySharedSyntaxStyle } = await import('@mission-control/tui/highlight');

    await bootstrapTreeSitter();

    const mountResult = await mountOpenTui(() =>
        createComponent(MissionControlTuiProviders, {
            useRenderer,
            runtimeOptions: options,
            chatStore: store,
            get children() {
                return createComponent(App, { store });
            },
        }),
    );

    return createChatTuiHandle(store, () => {
        mountResult.unmount();
        destroySharedSyntaxStyle();
        void closeTreeSitterClient();
    });
}
