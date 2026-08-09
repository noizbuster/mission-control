import { getModelContextLimit } from '@mission-control/config';
import { resolveMissionControlDataDir } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import type { ChatTuiHandle, ChatTuiRuntimeOptions } from './state/chat-tui-types';
import type { ModelsOverlayRoleRow } from './state/index';
import { type ChatStore, createChatStore } from './state/index';
import {
    clearPromptDraft,
    flushPromptDraftSync,
    notePromptDraft,
    readPromptDraft,
    registerPromptDraftFlushGlobal,
    unregisterPromptDraftFlushGlobal,
} from './state/prompt-draft';
import { createSoftRemountController } from './state/soft-remount';
import { retainTuiProcessLiveness } from './tui-process-liveness';

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
        enqueueEvent: (event) => store.enqueueEvent(event),
        emitOutput: (text) => store.emitOutput(text),
        emitTranscriptPart: (part, fallbackText) => store.emitTranscriptPart(part, fallbackText),
        emitTranscriptFallback: (text) => store.emitTranscriptFallback(text),
        replaceOutputText: (text) => store.replaceOutputText(text),
        undoLastViewExchange: () => store.undoLastViewExchange(),
        redoLastViewExchange: () => store.redoLastViewExchange(),
        replaceTranscript: (parts, outputText) => store.replaceTranscript(parts, outputText),
        getOutput: () => store.getOutput(),
        subscribeOutput: (listener) => {
            let last = store.getOutput();
            return store.subscribe(() => {
                const next = store.getOutput();
                if (next === last) return;
                last = next;
                listener(next);
            });
        },
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
        setSkillEntries: (entries) => store.setSkillEntries(entries),
        setModelCycleChoices: (choices) => store.setModelCycleChoices(choices),
        setModelSelection: (selection) => store.setModelSelection(selection),
        setApprovalLevel: (level) => store.setApprovalLevel(level),
        setSessionId: (id) => store.setSessionId(id),
        getSessionId: () => store.getSnapshot().sessionId,
        isEventQueueClosed: () => store.isEventQueueClosed(),
        isAgentsDurableBusy: () => store.isAgentsDurableBusy(),
        setSessionDisplayName: (name) => store.setSessionDisplayName(name),
        setContextTokensUsed: (used) => store.setContextTokensUsed(used),
        setContextTokensMax: (max) => store.setContextTokensMax(max),
        setContextTokensMaxFromStep: (max) => store.setContextTokensMaxFromStep(max),
        beginContextMaxReseed: () => store.beginContextMaxReseed(),
        shouldApplyContextMaxReseed: (epoch) => store.shouldApplyContextMaxReseed(epoch),
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
    const seedProviderID = options.providerID;
    const seedModelID = options.modelID;
    // Prefer the mount session id: setSessionId(options.sessionID) runs after this
    // fire-and-forget seed and would otherwise make seedSessionId '' self-cancel.
    const seedSessionId =
        options.sessionID !== undefined && options.sessionID.length > 0
            ? options.sessionID
            : store.getSnapshot().sessionId;
    const seedContextMaxEpoch = store.beginContextMaxReseed();
    void import('@mission-control/core')
        .then(async ({ TuiStores }) => {
            const prefs = await new TuiStores.TuiLocalPreferencesStore().getPreferences();
            const { resolveEffectiveContextLimit } = await import('@mission-control/config');
            // Drop stale seed if session/model changed, stepped, or the surface tore down mid-await.
            if (store.isEventQueueClosed()) return;
            if (!store.shouldApplyContextMaxReseed(seedContextMaxEpoch)) return;
            if (store.getSnapshot().sessionId !== seedSessionId) return;
            const live = store.getSnapshot().currentModelSelection;
            if (live !== undefined && (live.providerID !== seedProviderID || live.modelID !== seedModelID)) {
                return;
            }
            store.setContextTokensMax(
                resolveEffectiveContextLimit(
                    { providerID: seedProviderID, modelID: seedModelID },
                    prefs.modelContextPrefs,
                ),
            );
        })
        .catch((error: unknown) => {
            if (store.isEventQueueClosed()) return;
            if (!store.shouldApplyContextMaxReseed(seedContextMaxEpoch)) return;
            if (store.getSnapshot().sessionId !== seedSessionId) return;
            const message = error instanceof Error ? error.message : String(error);
            store.showTransientNotice(`Context prefs load failed: ${message}`);
        });

    const { useRenderer } = await import('@opentui/solid');
    const { mountOpenTui } = await import('@mission-control/tui/opentui-renderer');
    const { bootstrapTreeSitter } = await import('./platform/tree-sitter-bootstrap');
    const { App } = await import('@mission-control/tui/app');
    const { createComponent, createSignal } = await import('solid-js');
    const { MissionControlTuiProviders } = await import('@mission-control/tui/providers');
    const { closeTreeSitterClient, destroySharedSyntaxStyle } = await import('@mission-control/tui/highlight');

    await bootstrapTreeSitter();

    const loadSessionSnapshot = options.loadSessionSnapshot;
    const softRemount = createSoftRemountController(
        loadSessionSnapshot === undefined
            ? {}
            : {
                  reloadSnapshot: async () => {
                      await loadSessionSnapshot();
                  },
              },
    );
    const [remountGeneration, setRemountGeneration] = createSignal(softRemount.getGeneration());
    const unsubscribeRemount = softRemount.subscribe(() => {
        if (store.isEventQueueClosed()) return;
        const generation = softRemount.getGeneration();
        const last = softRemount.getLastRequest();
        const circuitOpen = softRemount.isCircuitOpen();
        setRemountGeneration(generation);
        store.setRemountDiagnostics({
            generation,
            circuitOpen,
            message: last?.message,
        });
        if (circuitOpen) {
            store.setStickyNotice(
                last?.message ??
                    'TUI recovery paused after repeated render errors. Session state is preserved; Ctrl+C exits.',
            );
            return;
        }
        if (last?.advanced === true) {
            store.showTransientNotice('TUI recovered from a render error (session state preserved).');
        }
    });

    let mountResult: Awaited<ReturnType<typeof mountOpenTui>>;
    try {
        mountResult = await mountOpenTui(() =>
            createComponent(MissionControlTuiProviders, {
                useRenderer,
                runtimeOptions: options,
                chatStore: store,
                ...(options.promptHistoryStore !== undefined ? { promptHistoryStore: options.promptHistoryStore } : {}),
                get children() {
                    return createComponent(App, {
                        store,
                        softRemount,
                        get remountGeneration() {
                            return remountGeneration();
                        },
                    });
                },
            }),
        );
    } catch (error: unknown) {
        // mountOpenTui restores terminal modes; the resources created before
        // that mount attempt still belong to this aborted TUI lifetime.
        unsubscribeRemount();
        softRemount.dispose();
        destroySharedSyntaxStyle();
        void closeTreeSitterClient();
        throw error;
    }

    registerPromptDraftFlushGlobal();
    let dataDir: string | undefined;
    try {
        dataDir = resolveMissionControlDataDir();
    } catch {
        dataDir = process.env['MCTRL_DATA_DIR'];
    }

    const releaseTuiProcessLiveness = retainTuiProcessLiveness();
    const handle = createChatTuiHandle(store, () => {
        releaseTuiProcessLiveness();
        notePromptDraft({
            dataDir,
            sessionId: store.getSnapshot().sessionId,
            text: store.getSnapshot().inputMirror,
        });
        flushPromptDraftSync();
        unregisterPromptDraftFlushGlobal();
        unsubscribeDraftTracking();
        unsubscribeRemount();
        softRemount.dispose();
        mountResult.unmount();
        destroySharedSyntaxStyle();
        void closeTreeSitterClient();
    });

    // Restore a crash-saved draft once, if the textarea is still empty.
    if (dataDir !== undefined && options.sessionID !== undefined && options.sessionID.length > 0) {
        store.setSessionId(options.sessionID);
        const draft = readPromptDraft(dataDir, options.sessionID);
        if (draft !== undefined && store.getSnapshot().inputMirror.length === 0) {
            store.setInputMirror(draft.text);
            store.showTransientNotice('Restored unsaved prompt draft from previous session.');
            clearPromptDraft(dataDir, options.sessionID);
        }
    }

    // Persist draft on input / session changes (debounced). On session switch,
    // flush the previous session's text under its id first, then restore any
    // crash draft for the newly attached session into an empty prompt.
    let trackedSessionId = store.getSnapshot().sessionId;
    let trackedText = store.getSnapshot().inputMirror;
    const unsubscribeDraftTracking = store.subscribe(() => {
        if (store.isEventQueueClosed()) return;
        const snap = store.getSnapshot();
        if (snap.sessionId !== trackedSessionId) {
            if (dataDir !== undefined && trackedSessionId.length > 0) {
                notePromptDraft({
                    dataDir,
                    sessionId: trackedSessionId,
                    text: trackedText,
                });
                flushPromptDraftSync();
            }
            trackedSessionId = snap.sessionId;
            trackedText = snap.inputMirror;
            if (dataDir !== undefined && trackedSessionId.length > 0 && snap.inputMirror.length === 0) {
                const draft = readPromptDraft(dataDir, trackedSessionId);
                if (draft !== undefined) {
                    store.setInputMirror(draft.text);
                    store.showTransientNotice('Restored unsaved prompt draft for this session.');
                    clearPromptDraft(dataDir, trackedSessionId);
                    // next subscribe tick notes the restored text
                    return;
                }
            }
        }
        trackedText = snap.inputMirror;
        notePromptDraft({
            dataDir,
            sessionId: snap.sessionId,
            text: snap.inputMirror,
        });
    });

    return handle;
}
