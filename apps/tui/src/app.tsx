/** @jsxImportSource @opentui/solid */

import { type ChatBlock, parseMessageBlocks } from '@mission-control/tui/chat';
import { useKeymap } from '@opentui/keymap/solid';
import { useRenderer, useTerminalDimensions } from '@opentui/solid';
import { type Accessor, createMemo, createSignal, type JSX, Show } from 'solid-js';
import {
    useChatSession,
    useTuiClipboard,
    useTuiLocalPreferences,
    useTuiPromptStash,
    useTuiRuntime,
} from './platform/providers/index.js';
import { useSolidStoreSelector } from './platform/use-solid-store-selector.js';
import type { ChatStore } from './state/chat-store.js';
import { ChatTranscript } from './components/ChatTranscript.js';
import {
    deriveStatusBarProps,
    preserveBlockReferences,
    promptPanelRepaintKey,
} from './app/app-helpers.js';
import { FullscreenOverlays } from './app/FullscreenOverlays.js';
import { ModalOverlays } from './app/ModalOverlays.js';
import { UpperRegion } from './app/UpperRegion.js';
import { KeymapChrome } from './platform/keymap/keymap-chrome.js';
import { useGlobalKeyboard } from './app/use-global-keyboard.js';
import { useKeymapLayers } from './app/use-keymap-layers.js';
import { useRenderableHandles } from './app/use-renderable-handles.js';
import { useRepaintEffects } from './app/use-repaint-effects.js';
import { useSelectionMouseUp } from './app/use-selection-mouseup.js';
import { useSubmit } from './app/use-submit.js';
import { useTransientToast } from './app/use-transient-toast.js';
import { DialogHost } from './components/dialog/dialog-host.js';
import { DialogProvider } from './components/dialog/dialog.js';
import { ChatBottomDock } from './components/ChatBottomDock.js';
import { bottomDockPolicy } from './components/chat-bottom-dock-policy.js';

export {
    type PromptPanelRepaintKeyInput,
    deriveStatusBarProps,
    parseModelPreferenceKeys,
    preserveBlockReferences,
    promptPanelRepaintKey,
    recentModelPreferenceSelections,
} from './app/app-helpers.js';

function createStableMessageBlocks(outputText: Accessor<string>): Accessor<readonly ChatBlock[]> {
    let previous: readonly ChatBlock[] = [];
    return createMemo(() => {
        const fresh = parseMessageBlocks(outputText());
        const stable = preserveBlockReferences(fresh, previous);
        previous = stable;
        return stable;
    });
}

export type AppProps = {
    readonly store: ChatStore;
};

export function App(props: AppProps): JSX.Element {
    return <AppMain store={props.store} />;
}

/**
 * Root shell matches ref/opencode packages/tui app.tsx:
 * width={dimensions().width} height={dimensions().height}, flex column,
 * main flexGrow+minHeight={0}, bottom flexShrink={0}. No custom SIGWINCH.
 */
function AppMain(props: AppProps): JSX.Element {
    const snapshot = useSolidStoreSelector(props.store, (state) => state);
    const runtime = useTuiRuntime();
    const session = useChatSession();
    const welcomeData = session.welcomeData;
    const abgOverlayController = session.abgOverlayController;
    const missionControlServices = session.missionControlServices;
    const actions = session.actions;
    const statusBarProps = () => deriveStatusBarProps(runtime, snapshot());
    const { textareaHandle, scrollboxHandle, keymapScrollboxRef } = useRenderableHandles();

    const initialPrefs = props.store.getAbgOverlayPrefsSnapshot();
    const [abgActiveTab, setAbgActiveTab] = createSignal(initialPrefs.activeTabIndex);
    const [abgScrollOffset, setAbgScrollOffset] = createSignal(initialPrefs.scrollOffset);

    const keymap = useKeymap();
    const renderer = useRenderer();
    const clipboard = useTuiClipboard();
    const promptStash = useTuiPromptStash();
    const localPreferences = useTuiLocalPreferences();
    const dimensions = useTerminalDimensions();
    const dockPolicy = () =>
        bottomDockPolicy({
            columns: dimensions().width,
            rows: dimensions().height,
        });
    const promptMenuInteractionsEnabled = () => dockPolicy().menu.rows > 0;

    useTransientToast(props.store);
    const handleSelectionMouseUp = useSelectionMouseUp();
    const handleSubmit = useSubmit({
        store: props.store,
        textareaHandle,
        promptMenuInteractionsEnabled,
    });

    useGlobalKeyboard({
        store: props.store,
        textareaHandle,
        setAbgActiveTab,
        setAbgScrollOffset,
        abgOverlayController,
    });

    useKeymapLayers({
        store: props.store,
        keymap,
        renderer,
        clipboard,
        getViewportRows: () => dimensions().height,
        promptStash,
        localPreferences,
        textareaHandle,
        scrollboxRef: keymapScrollboxRef,
        promptMenuInteractionsEnabled: () => promptMenuInteractionsEnabled(),
        handleSubmit,
    });

    const messageBlocks = createStableMessageBlocks(() => snapshot().outputText);
    const overlayActive = () => snapshot().overlayMode !== 'none';
    const showWelcome = () => welcomeData !== undefined && snapshot().outputText === '' && !overlayActive();
    const promptRepaintKey = () =>
        promptPanelRepaintKey({
            inputMirror: snapshot().inputMirror,
            fileAutocompleteOpen: snapshot().fileAutocomplete.open,
            fileMatchCount: snapshot().fileAutocomplete.matches.length,
            menuRows: dockPolicy().menu.rows,
        });

    useRepaintEffects({
        renderer,
        overlayMode: () => snapshot().overlayMode,
        generating: () => snapshot().generating,
        promptRepaintKey,
    });

    const showAgentIndicator = () => !overlayActive();
    const showAbgMinimap = () =>
        snapshot().abgMinimapVisible && !overlayActive() && abgOverlayController !== undefined;
    const isFullscreenOverlay = () => {
        const mode = snapshot().overlayMode;
        return mode === 'abg' || mode === 'diff-viewer' || mode === 'models-overlay';
    };

    return (
        <DialogProvider>
            <DialogHost store={props.store} />
            {/* biome-ignore lint/a11y/noStaticElementInteractions: opentui terminal primitive; mouse-up surfaces copy-hint toast. */}
            <box
                width={dimensions().width}
                height={dimensions().height}
                flexDirection="column"
                backgroundColor="#000000"
                onMouseUp={handleSelectionMouseUp}
            >
                <Show when={isFullscreenOverlay()}>
                    <FullscreenOverlays
                        store={props.store}
                        snap={snapshot()}
                        viewport={{ columns: dimensions().width, rows: dimensions().height }}
                        statusBarProps={statusBarProps()}
                        abgOverlayController={abgOverlayController}
                        abgActiveTabIndex={abgActiveTab()}
                        abgScrollOffset={abgScrollOffset()}
                    />
                </Show>
                <Show when={!isFullscreenOverlay()}>
                    <box flexDirection="column" flexGrow={1} minHeight={0} width="100%">
                        <UpperRegion
                            showWelcome={showWelcome()}
                            welcomeData={welcomeData}
                            statusBarProps={statusBarProps()}
                            transcript={
                                <ChatTranscript
                                    blocks={messageBlocks()}
                                    scrollboxRef={scrollboxHandle}
                                    generating={snapshot().generating}
                                    toolOutputExpanded={snapshot().toolOutputExpanded}
                                />
                            }
                            showAgentIndicator={showAgentIndicator()}
                            agentStatusText={snapshot().agentStatusText}
                            generating={snapshot().generating}
                            showAbgMinimap={showAbgMinimap()}
                            abgOverlayController={abgOverlayController}
                        />
                    </box>
                    <box flexShrink={0} width="100%">
                        <ChatBottomDock
                            store={props.store}
                            textareaRef={textareaHandle}
                            scrollboxRef={scrollboxHandle}
                            inputFocused={!overlayActive()}
                            statusBarProps={statusBarProps()}
                            {...(actions !== undefined ? { actions } : {})}
                        />
                    </box>
                    <ModalOverlays
                        store={props.store}
                        overlayMode={snapshot().overlayMode}
                        workspaceRoot={statusBarProps().workspaceRoot}
                        actions={actions}
                        missionControlServices={missionControlServices}
                    />
                </Show>
                <KeymapChrome />
            </box>
        </DialogProvider>
    );
}
