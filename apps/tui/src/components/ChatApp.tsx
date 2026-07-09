/** @jsxImportSource @opentui/solid */

import { type ChatBlock, parseMessageBlocks } from '@mission-control/tui/chat';
import { TextAttributes } from '@opentui/core';
import { useKeymap } from '@opentui/keymap/solid';
import { useRenderer } from '@opentui/solid';
import { type Accessor, createMemo, createSignal, type JSX } from 'solid-js';
import { buildDiffViewerModel, DiffViewerOverlay } from '../platform/keymap/diff-viewer.js';
import {
    useChatSession,
    useTuiClipboard,
    useTuiLocalPreferences,
    useTuiPromptStash,
    useTuiRuntime,
} from '../platform/providers/index.js';
import type { TuiRuntimeProviderValue } from '../platform/providers/runtime-context.js';
import { useTerminalViewport } from '../platform/terminal-viewport-solid.js';
import { useSolidStoreSelector } from '../platform/use-solid-store-selector.js';
import type { ChatStore, ChatStoreState } from '../state/chat-store.js';
import { AbgMinimap } from './AbgMinimap.js';
import { ABG_OVERLAY_TABS, AbgOverlay, type AbgOverlayTab } from './AbgOverlay.js';
import { ChatBottomDock } from './ChatBottomDock.js';
import { ChatTranscript } from './ChatTranscript.js';
import {
    preserveBlockReferences,
    promptPanelRepaintKey,
} from './chat-app/chat-app-helpers.js';
import { useChatGlobalKeyboard } from './chat-app/use-chat-global-keyboard.js';
import { useChatKeymapLayers } from './chat-app/use-chat-keymap-layers.js';
import { useChatRenderableHandles } from './chat-app/use-chat-renderable-handles.js';
import { useChatRepaintEffects } from './chat-app/use-chat-repaint-effects.js';
import { useChatSelectionMouseUp } from './chat-app/use-chat-selection-mouseup.js';
import { useChatSubmit } from './chat-app/use-chat-submit.js';
import { useChatTransientToast } from './chat-app/use-chat-transient-toast.js';
import { bottomDockPolicy } from './chat-bottom-dock-policy.js';
import { MissionPanelOverlay } from './MissionPanelOverlay.js';
import { ModelsOverlay } from './ModelsOverlay.js';
import { OverlayFrame } from './OverlayFrame.js';
import {
    AgentsDashboardOverlay,
    ApprovalOverlay,
    LevelPickerOverlay,
    ModelPickerOverlay,
    RenameOverlay,
    SessionPickerOverlay,
} from './OverlayPanels.js';
import { type StatusBarProps } from './StatusBar.js';
import { useSpinnerFrame } from './spinner.js';
import { Toast } from './Toast.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { basename } from 'node:path';

export {
    type PromptPanelRepaintKeyInput,
    parseModelPreferenceKeys,
    preserveBlockReferences,
    promptPanelRepaintKey,
    recentModelPreferenceSelections,
} from './chat-app/chat-app-helpers.js';

// Two memos: outer avoids re-parsing when outputText is stable (overlay toggles);
// inner avoids re-comparing when the parse result is stable. prevRef holds the last
// stable result for the next comparison.
function createStableMessageBlocks(outputText: Accessor<string>): Accessor<readonly ChatBlock[]> {
    let previous: readonly ChatBlock[] = [];
    return createMemo(() => {
        const fresh = parseMessageBlocks(outputText());
        const stable = preserveBlockReferences(fresh, previous);
        previous = stable;
        return stable;
    });
}

function AgentSpinner({ text }: { readonly text: string }): JSX.Element {
    const { glyph } = useSpinnerFrame();
    return (
        <box marginTop={1} flexShrink={0}>
            <text fg="#00ffff">{`${glyph} ${text}`}</text>
        </box>
    );
}

export type ChatAppProps = {
    readonly store: ChatStore;
};

export function deriveStatusBarProps(runtime: TuiRuntimeProviderValue, snap: ChatStoreState): StatusBarProps {
    const selection = snap.currentModelSelection;
    const providerID = selection?.providerID ?? runtime.providerID;
    const modelID = selection?.modelID ?? runtime.modelID;
    const variantID = selection?.variantID ?? snap.currentModelVariantID ?? runtime.variantID;
    const sessionID = snap.sessionId.length > 0 ? snap.sessionId : runtime.sessionID;
    return {
        providerID,
        modelID,
        ...(variantID !== undefined ? { variantID } : {}),
        ...(sessionID !== undefined && sessionID.length > 0 ? { sessionID } : {}),
        ...(runtime.workspaceRoot !== undefined ? { workspaceRoot: runtime.workspaceRoot } : {}),
        ...(runtime.gitBranch !== undefined ? { gitBranch: runtime.gitBranch } : {}),
        ...(runtime.isWorktree ? { isWorktree: true } : {}),
    };
}

export function ChatApp({ store }: ChatAppProps): JSX.Element {
    const snapshot = useSolidStoreSelector(store, (state) => state);
    const runtime = useTuiRuntime();
    const session = useChatSession();
    const welcomeData = session.welcomeData;
    const abgOverlayController = session.abgOverlayController;
    const missionControlServices = session.missionControlServices;
    const actions = session.actions;
    const statusBarProps = createMemo(() => deriveStatusBarProps(runtime, snapshot()));
    const { textareaHandle, scrollboxHandle, keymapScrollboxRef } = useChatRenderableHandles();

    // Seeded from persisted prefs so a user's last tab/scroll survives an overlay reopen.
    const initialPrefs = store.getAbgOverlayPrefsSnapshot();
    const [abgActiveTab, setAbgActiveTab] = createSignal(initialPrefs.activeTabIndex);
    const [abgScrollOffset, setAbgScrollOffset] = createSignal(initialPrefs.scrollOffset);

    const keymap = useKeymap();
    const renderer = useRenderer();
    const clipboard = useTuiClipboard();
    const promptStash = useTuiPromptStash();
    const localPreferences = useTuiLocalPreferences();
    const viewport = useTerminalViewport();
    const dockPolicy = createMemo(() => bottomDockPolicy(viewport()));
    const promptMenuInteractionsEnabled = createMemo(() => dockPolicy().menu.rows > 0);

    useChatTransientToast(store);
    const handleSelectionMouseUp = useChatSelectionMouseUp();
    // Wire the submit handler the chat.submit keymap layer (T3) invokes. The
    // keymap owns the return/kpenter chord (native keyBindings are suspended),
    // so this is the sole Enter-submit path.
    const handleSubmit = useChatSubmit({
        store,
        textareaHandle,
        promptMenuInteractionsEnabled,
    });

    useChatGlobalKeyboard({
        store,
        textareaHandle,
        setAbgActiveTab,
        setAbgScrollOffset,
        abgOverlayController,
    });

    useChatKeymapLayers({
        store,
        keymap,
        renderer,
        clipboard,
        viewport,
        promptStash,
        localPreferences,
        textareaHandle,
        scrollboxRef: keymapScrollboxRef,
        promptMenuInteractionsEnabled: () => promptMenuInteractionsEnabled(),
        handleSubmit,
    });

    const messageBlocks = createStableMessageBlocks(() => snapshot().outputText);
    const overlayActive = createMemo(() => snapshot().overlayMode !== 'none');
    const showWelcome = createMemo(() => welcomeData !== undefined && snapshot().outputText === '' && !overlayActive());
    const promptRepaintKey = createMemo(() =>
        promptPanelRepaintKey({
            inputMirror: snapshot().inputMirror,
            fileAutocompleteOpen: snapshot().fileAutocomplete.open,
            fileMatchCount: snapshot().fileAutocomplete.matches.length,
            menuRows: dockPolicy().menu.rows,
        }),
    );

    useChatRepaintEffects({
        renderer,
        viewport,
        overlayMode: () => snapshot().overlayMode,
        generating: () => snapshot().generating,
        promptRepaintKey,
    });

    const transcript = createMemo(() => (
        <ChatTranscript
            blocks={messageBlocks()}
            scrollboxRef={scrollboxHandle}
            generating={snapshot().generating}
            toolOutputExpanded={snapshot().toolOutputExpanded}
            viewportColumns={viewport().columns}
        />
    ));

    // ModalPopup auto-sizes to content (no `bottom`), so the AgentSpinner's
    // 80ms Braille animation leaks under the popup edge and surfaces as mojibake.
    // Match the 'abg'/'diff-viewer' early-return replacement intent.
    const showAgentIndicator = createMemo(() => !overlayActive());
    const showAbgMinimap = createMemo(
        () => snapshot().abgMinimapVisible && !overlayActive() && abgOverlayController !== undefined,
    );

    const rootContent = createMemo((): JSX.Element => {
        const snap = snapshot();

        if (snap.overlayMode === 'abg') {
            if (abgOverlayController === undefined) {
                return (
                    <box flexDirection="column" width={viewport().columns} height={viewport().rows} shouldFill={true}>
                        <OverlayFrame variant="view" title="ABG Overlay" hint="(Ctrl+G or Esc to close)">
                            <text attributes={TextAttributes.DIM}>{'ABG overlay unavailable in this session.'}</text>
                        </OverlayFrame>
                    </box>
                );
            }

            const bar = statusBarProps();
            const selection = snap.currentModelSelection;
            const providerID = selection?.providerID ?? bar.providerID;
            const modelID = selection?.modelID ?? bar.modelID;
            const variantID = snap.currentModelVariantID;
            const modelLabel = `${providerID}/${modelID}${variantID !== undefined ? `#${variantID}` : ''}`;
            const activeTab: AbgOverlayTab = ABG_OVERLAY_TABS[abgActiveTab()] ?? 'overview';

            return (
                <box flexDirection="column" width={viewport().columns} height={viewport().rows} shouldFill={true}>
                    <AbgOverlay
                        store={abgOverlayController.store}
                        activeTab={activeTab}
                        scrollOffset={abgScrollOffset()}
                        modelLabel={modelLabel}
                        viewport={viewport()}
                    />
                </box>
            );
        }

        if (snap.overlayMode === 'diff-viewer') {
            const entries = snap.diffViewerEntries;
            const cursor = snap.diffViewerCursor;
            const model = buildDiffViewerModel(entries);

            return (
                <box flexDirection="column" width={viewport().columns} height={viewport().rows} shouldFill={true}>
                    <DiffViewerOverlay entries={entries} model={model} cursor={cursor} />
                </box>
            );
        }

        if (snap.overlayMode === 'models-overlay') {
            return (
                <box flexDirection="column" width={viewport().columns} height={viewport().rows} shouldFill={true}>
                    <ModelsOverlay store={store} />
                </box>
            );
        }

        const bar = statusBarProps();
        const upperOutputRegion = (
            <>
                {showWelcome() && welcomeData !== undefined ? (
                    <WelcomeScreen
                        data={welcomeData}
                        viewportColumns={viewport().columns}
                        availableRows={dockPolicy().transcript.rows}
                        {...(bar.workspaceRoot !== undefined
                            ? { projectLabel: basename(bar.workspaceRoot) }
                            : {})}
                        {...(bar.gitBranch !== undefined ? { gitBranch: bar.gitBranch } : {})}
                        {...(bar.isWorktree !== undefined ? { isWorktree: bar.isWorktree } : {})}
                    />
                ) : (
                    transcript()
                )}
                {showAgentIndicator() && snap.agentStatusText.length > 0 ? (
                    <AgentSpinner text={snap.agentStatusText} />
                ) : showAgentIndicator() && snap.generating ? (
                    <AgentSpinner text="Working..." />
                ) : null}
                <Toast />
                {showAbgMinimap() && abgOverlayController !== undefined ? (
                    <AbgMinimap store={abgOverlayController.store} viewport={viewport()} />
                ) : null}
            </>
        );
        const bottomDock = (
            <ChatBottomDock
                store={store}
                textareaRef={textareaHandle}
                scrollboxRef={scrollboxHandle}
                inputFocused={!overlayActive()}
                viewportColumns={viewport().columns}
                viewportRows={viewport().rows}
                statusBarProps={bar}
                {...(actions !== undefined ? { actions } : {})}
            />
        );
        const modalOverlays = (
            <>
                {snap.overlayMode === 'approval' ? (
                    <ModalPopup>
                        <ApprovalOverlay store={store} />
                    </ModalPopup>
                ) : null}
                {snap.overlayMode === 'model-picker' ? (
                    <ModalPopup>
                        <ModelPickerOverlay store={store} />
                    </ModalPopup>
                ) : null}
                {snap.overlayMode === 'level-picker' ? (
                    <ModalPopup>
                        <LevelPickerOverlay store={store} />
                    </ModalPopup>
                ) : null}
                {snap.overlayMode === 'rename' ? (
                    <ModalPopup>
                        <RenameOverlay store={store} />
                    </ModalPopup>
                ) : null}
                {snap.overlayMode === 'session-picker' ? (
                    <ModalPopup>
                        <SessionPickerOverlay store={store} />
                    </ModalPopup>
                ) : null}
                {snap.overlayMode === 'agents-dashboard' ? (
                    <ModalPopup>
                        <AgentsDashboardOverlay
                            store={store}
                            workspaceRoot={bar.workspaceRoot}
                            {...(actions !== undefined ? { actions } : {})}
                        />
                    </ModalPopup>
                ) : null}
                {snap.overlayMode === 'mission-panel' ? (
                    <ModalPopup>
                        <MissionPanelOverlay
                            store={store}
                            workspaceRoot={bar.workspaceRoot}
                            {...(actions !== undefined ? { actions } : {})}
                            {...(missionControlServices !== undefined ? { services: missionControlServices } : {})}
                        />
                    </ModalPopup>
                ) : null}
            </>
        );
        return (
            // biome-ignore lint/a11y/noStaticElementInteractions: opentui terminal primitive, not a DOM element; mouse-up only surfaces the copy-hint toast.
            <box flexDirection="column" width={viewport().columns} height={viewport().rows} shouldFill={true} onMouseUp={handleSelectionMouseUp}>
                <box flexDirection="column" flexGrow={1} shouldFill={true}>
                    {upperOutputRegion}
                </box>
                {bottomDock}
                {modalOverlays}
            </box>
        );
    });

    return <>{rootContent()}</>;
}

function ModalPopup({ children }: { readonly children: JSX.Element }): JSX.Element {
    return (
        <box
            position="absolute"
            top={1}
            left={2}
            right={2}
            backgroundColor="#0a0a0a"
            borderStyle="single"
            borderColor="#808080"
        >
            {children}
        </box>
    );
}
