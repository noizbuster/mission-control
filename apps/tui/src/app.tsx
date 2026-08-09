/** @jsxImportSource @opentui/solid */

import { type ChatBlock, parseMessageBlocks } from '@mission-control/tui/chat';
import { useKeymap } from '@opentui/keymap/solid';
import { useRenderer, useTerminalDimensions } from '@opentui/solid';
import { useContext, type Accessor, createEffect, createMemo, createSignal, type JSX, Show } from 'solid-js';
import { deriveStatusBarProps, preserveBlockReferences, promptPanelRepaintKey } from './app/app-helpers';
import { FullscreenOverlays } from './app/FullscreenOverlays';
import { ModalOverlays } from './app/ModalOverlays';
import { UpperRegion } from './app/UpperRegion';
import { useGlobalKeyboard } from './app/use-global-keyboard';
import { useKeymapLayers } from './app/use-keymap-layers';
import { useRenderableHandles } from './app/use-renderable-handles';
import { useRepaintEffects } from './app/use-repaint-effects';
import { useSelectionMouseUp } from './app/use-selection-mouseup';
import { useSubmit } from './app/use-submit';
import { useTransientToast } from './app/use-transient-toast';
import { AppShell } from './components/AppShell';
import { ChatBottomDock } from './components/ChatBottomDock';
import { ChatTranscript } from './components/ChatTranscript';
import { bottomDockPolicy } from './components/chat-bottom-dock-policy';
import { CHAT_BG } from './components/chat-theme';
import { DialogOverlay, DialogProvider } from './components/dialog/dialog';
import { KeymapChrome } from './platform/keymap/keymap-chrome';
import { PaletteOpenContext } from './platform/keymap/palette-open-context';
import {
    useChatSession,
    useTuiClipboard,
    useTuiLocalPreferences,
    useTuiPromptStash,
    useTuiRuntime,
} from './platform/providers/index';
import { useSolidStoreSelector } from './platform/use-solid-store-selector';
import type { ChatStore } from './state/chat-store';
import type { SoftRemountController } from './state/soft-remount';

export {
    deriveStatusBarProps,
    type PromptPanelRepaintKeyInput,
    parseModelPreferenceKeys,
    preserveBlockReferences,
    promptPanelRepaintKey,
    recentModelPreferenceSelections,
} from './app/app-helpers';

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
    readonly softRemount?: SoftRemountController;
    /** Bumps on soft remount so Solid rebuilds the tree under a fresh key. */
    readonly remountGeneration?: number;
};

export function App(props: AppProps): JSX.Element {
    // ErrorBoundary keeps a render throw from blanking the terminal with no
    // recovery UI. ChatStore stays alive outside the boundary so CLI can still
    // push replaceTranscript / unmount after a fatal paint failure.
    // createMemo re-creates AppMain when remountGeneration bumps so native
    // scrollbox/textarea subtrees are disposed and rebuilt cleanly.
    const main = createMemo(() => {
        const generation = props.remountGeneration ?? 0;
        return <AppMain store={props.store} remountGeneration={generation} />;
    });
    return (
        <AppShell
            {...(props.softRemount !== undefined ? { softRemount: props.softRemount } : {})}
            isEventQueueClosed={() => props.store.isEventQueueClosed()}
            onFatalRenderError={(message) => {
                props.store.setStickyNotice(`TUI recovery stopped: ${message}`);
                props.store.closeEventQueue();
            }}
        >
            {main()}
        </AppShell>
    );
}

/**
 * Root shell matches ref/opencode packages/tui app.tsx:
 * width={dimensions().width} height={dimensions().height}, flex column,
 * main flexGrow+minHeight={0}, bottom flexShrink={0}. No custom SIGWINCH.
 */
function AppMain(props: { readonly store: ChatStore; readonly remountGeneration: number }): JSX.Element {
    const snapshot = useSolidStoreSelector(props.store, (state) => state);
    const runtime = useTuiRuntime();
    const session = useChatSession();
    const welcomeData = session.welcomeData;
    const abgOverlayController = session.abgOverlayController;
    const missionControlServices = session.missionControlServices;
    const actions = session.actions;

    const statusBarProps = () => {
        const base = deriveStatusBarProps(runtime, snapshot());
        const sessionID = base.sessionID;
        if (sessionID === undefined || sessionID.length === 0) {
            return base;
        }
        return {
            ...base,
            onCopySessionID: () => {
                void clipboard.copyWithNotice(sessionID);
            },
        };
    };
    const { textareaHandle, scrollboxHandle, keymapScrollboxRef } = useRenderableHandles();

    // Tab/scroll are store-owned so soft-remount + teardown persist see live values.
    // panX stays session-local (not in AbgOverlayPrefsSchema).
    const [abgPanX, setAbgPanX] = createSignal(0);
    const abgActiveTab = createMemo(() => snapshot().abgOverlayActiveTab);
    const abgScrollOffset = createMemo(() => snapshot().abgOverlayScrollOffset);

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
    const paletteOpenState = useContext(PaletteOpenContext);
    const handleSubmit = useSubmit({
        store: props.store,
        textareaHandle,
        promptMenuInteractionsEnabled,
        // Prompt history durability is CLI-owned (appendInputHistoryEntry).
        // TUI must not dual-write the same submit.
        isSubmitEnabled: () => paletteOpenState?.open() !== true,
    });

    useGlobalKeyboard({
        store: props.store,
        textareaHandle,
        setAbgPanX,
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
        isChatSubmitEnabled: () => paletteOpenState?.open() !== true,
        isInteractiveIdle: () => {
            const snap = props.store.getSnapshot();
            return snap.overlayMode === 'none' && paletteOpenState?.open() !== true && !snap.historyPicker.open;
        },
    });

    const messageBlocks = createStableMessageBlocks(() =>
        snapshot().transcriptParts.length > 0 ? '' : snapshot().outputText,
    );
    const overlayActive = () => snapshot().overlayMode !== 'none';
    createEffect(() => {
        // Decision/view overlays (and history picker) own the keyboard; block palette.
        const idle = !overlayActive() && !snapshot().historyPicker.open;
        paletteOpenState?.setCanOpen(idle);
        if (!idle && paletteOpenState?.open() === true) {
            paletteOpenState.setOpen(false);
        }
    });
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
        abgNavKey: () => `${abgActiveTab()}:${abgScrollOffset()}:${abgPanX()}`,
    });

    const showAbgMinimap = () => snapshot().abgMinimapVisible && !overlayActive() && abgOverlayController !== undefined;
    const isFullscreenOverlay = () => {
        const mode = snapshot().overlayMode;
        return mode === 'abg' || mode === 'diff-viewer' || mode === 'models-overlay';
    };

    return (
        <DialogProvider>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: opentui terminal primitive; mouse-up surfaces copy-hint toast. */}
            <box
                width={dimensions().width}
                height={dimensions().height}
                flexDirection="column"
                backgroundColor={CHAT_BG}
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
                        abgPanX={abgPanX()}
                    />
                </Show>
                <Show when={!isFullscreenOverlay()}>
                    <box flexDirection="column" flexGrow={1} minHeight={0} width="100%">
                        <UpperRegion
                            showWelcome={showWelcome()}
                            welcomeData={welcomeData}
                            statusBarProps={statusBarProps()}
                            // IMPORTANT: pass <ChatTranscript> as inline JSX, NEVER wrapped in an
                            // IIFE or any indirect call. Solid's compiler reconciles inline JSX by
                            // component type across parent re-renders; an IIFE wrapper produces a
                            // new JSX.Element ref on every snapshot publish and Solid unmounts +
                            // remounts <ChatTranscript>, which rebuilt the scrollbox and flashed the
                            // scrollbar on every keystroke. See apps/tui/AGENTS.md "JSX Element
                            // Identity And Component Props". Regression test: app-topology.test.ts.
                            transcript={
                                <ChatTranscript
                                    blocks={messageBlocks()}
                                    transcriptParts={snapshot().transcriptParts}
                                    scrollboxRef={scrollboxHandle}
                                    generating={snapshot().generating}
                                    showThinking={snapshot().showThinking}
                                    toolOutputExpanded={snapshot().toolOutputExpanded}
                                    activeAssistantMessageId={snapshot().activeAssistantMessageId}
                                />
                            }
                            showAbgMinimap={showAbgMinimap()}
                            abgOverlayController={abgOverlayController}
                            stickyNotice={snapshot().stickyNotice}
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
                    <DialogOverlay store={props.store} />
                </Show>
                <KeymapChrome />
            </box>
        </DialogProvider>
    );
}
