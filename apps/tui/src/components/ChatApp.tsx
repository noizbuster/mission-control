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
} from '../platform/providers/index.js';
import { useTerminalViewport } from '../platform/terminal-viewport-solid.js';
import { useSolidStoreSelector } from '../platform/use-solid-store-selector.js';
import type { ChatStore } from '../state/chat-store.js';
import { ChatTranscript } from './ChatTranscript.js';
import {
    deriveStatusBarProps,
    preserveBlockReferences,
    promptPanelRepaintKey,
} from './chat-app/chat-app-helpers.js';
import { ChatFullscreenOverlays } from './chat-app/ChatFullscreenOverlays.js';
import { ChatNormalLayout } from './chat-app/ChatNormalLayout.js';
import { useChatGlobalKeyboard } from './chat-app/use-chat-global-keyboard.js';
import { useChatKeymapLayers } from './chat-app/use-chat-keymap-layers.js';
import { useChatRenderableHandles } from './chat-app/use-chat-renderable-handles.js';
import { useChatRepaintEffects } from './chat-app/use-chat-repaint-effects.js';
import { useChatSelectionMouseUp } from './chat-app/use-chat-selection-mouseup.js';
import { useChatSubmit } from './chat-app/use-chat-submit.js';
import { useChatTransientToast } from './chat-app/use-chat-transient-toast.js';
import { bottomDockPolicy } from './chat-bottom-dock-policy.js';

export {
    type PromptPanelRepaintKeyInput,
    deriveStatusBarProps,
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

export type ChatAppProps = {
    readonly store: ChatStore;
};

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

        if (
            snap.overlayMode === 'abg' ||
            snap.overlayMode === 'diff-viewer' ||
            snap.overlayMode === 'models-overlay'
        ) {
            return (
                <ChatFullscreenOverlays
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
            <ChatNormalLayout
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
