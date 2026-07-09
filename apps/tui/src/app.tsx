/** @jsxImportSource @opentui/solid */

import { type ChatBlock, parseMessageBlocks } from '@mission-control/tui/chat';
import { useKeymap } from '@opentui/keymap/solid';
import { useRenderer } from '@opentui/solid';
import { type Accessor, createMemo, createSignal, type JSX } from 'solid-js';
import {
    useChatSession,
    useTuiClipboard,
    useTuiLocalPreferences,
    useTuiPromptStash,
    useTuiRuntime,
} from './platform/providers/index.js';
import { useTerminalViewport } from './platform/terminal-viewport-solid.js';
import { useSolidStoreSelector } from './platform/use-solid-store-selector.js';
import type { ChatStore } from './state/chat-store.js';
import { ChatTranscript } from './components/ChatTranscript.js';
import {
    deriveStatusBarProps,
    preserveBlockReferences,
    promptPanelRepaintKey,
} from './app/app-helpers.js';
import { FullscreenOverlays } from './app/FullscreenOverlays.js';
import { NormalLayout } from './app/NormalLayout.js';
import { useGlobalKeyboard } from './app/use-global-keyboard.js';
import { useKeymapLayers } from './app/use-keymap-layers.js';
import { useRenderableHandles } from './app/use-renderable-handles.js';
import { useRepaintEffects } from './app/use-repaint-effects.js';
import { useSelectionMouseUp } from './app/use-selection-mouseup.js';
import { useSubmit } from './app/use-submit.js';
import { useTransientToast } from './app/use-transient-toast.js';
import { bottomDockPolicy } from './components/chat-bottom-dock-policy.js';

export {
    type PromptPanelRepaintKeyInput,
    deriveStatusBarProps,
    parseModelPreferenceKeys,
    preserveBlockReferences,
    promptPanelRepaintKey,
    recentModelPreferenceSelections,
} from './app/app-helpers.js';

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

export type AppProps = {
    readonly store: ChatStore;
};

export function App({ store }: AppProps): JSX.Element {
    const snapshot = useSolidStoreSelector(store, (state) => state);
    const runtime = useTuiRuntime();
    const session = useChatSession();
    const welcomeData = session.welcomeData;
    const abgOverlayController = session.abgOverlayController;
    const missionControlServices = session.missionControlServices;
    const actions = session.actions;
    const statusBarProps = createMemo(() => deriveStatusBarProps(runtime, snapshot()));
    const { textareaHandle, scrollboxHandle, keymapScrollboxRef } = useRenderableHandles();

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

    useTransientToast(store);
    const handleSelectionMouseUp = useSelectionMouseUp();
    // Wire the submit handler the chat.submit keymap layer (T3) invokes. The
    // keymap owns the return/kpenter chord (native keyBindings are suspended),
    // so this is the sole Enter-submit path.
    const handleSubmit = useSubmit({
        store,
        textareaHandle,
        promptMenuInteractionsEnabled,
    });

    useGlobalKeyboard({
        store,
        textareaHandle,
        setAbgActiveTab,
        setAbgScrollOffset,
        abgOverlayController,
    });

    useKeymapLayers({
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

    useRepaintEffects({
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

        if (
            snap.overlayMode === 'abg' ||
            snap.overlayMode === 'diff-viewer' ||
            snap.overlayMode === 'models-overlay'
        ) {
            return (
                <FullscreenOverlays
                    store={store}
                    snap={snap}
                    viewport={viewport()}
                    statusBarProps={statusBarProps()}
                    abgOverlayController={abgOverlayController}
                    abgActiveTabIndex={abgActiveTab()}
                    abgScrollOffset={abgScrollOffset()}
                />
            );
        }

        return (
            <NormalLayout
                store={store}
                snap={snap}
                viewport={viewport()}
                statusBarProps={statusBarProps()}
                onMouseUp={handleSelectionMouseUp}
                textareaHandle={textareaHandle}
                scrollboxHandle={scrollboxHandle}
                overlayActive={overlayActive()}
                actions={actions}
                missionControlServices={missionControlServices}
                showWelcome={showWelcome()}
                welcomeData={welcomeData}
                dockPolicy={dockPolicy()}
                transcript={transcript()}
                showAgentIndicator={showAgentIndicator()}
                showAbgMinimap={showAbgMinimap()}
                abgOverlayController={abgOverlayController}
            />
        );
    });

    return <>{rootContent()}</>;
}
