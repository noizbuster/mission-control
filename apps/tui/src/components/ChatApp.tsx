/** @jsxImportSource @opentui/solid */

import { type ChatBlock, extractLastAssistantText, parseMessageBlocks } from '@mission-control/tui/chat';
import { type ScrollBoxRenderable, TextAttributes, type TextareaRenderable } from '@opentui/core';
import { useKeymap } from '@opentui/keymap/solid';
import { useKeyboard, useRenderer } from '@opentui/solid';
import { type Accessor, createEffect, createMemo, createSignal, type JSX, onCleanup, onMount } from 'solid-js';
import {
    buildDiffViewerModel,
    DiffViewerOverlay,
    moveLine,
    nextFile,
    nextHunk,
    prevFile,
    prevHunk,
} from '../platform/keymap/diff-viewer.js';
import { hardResetRendererSurface } from '../platform/opentui-renderer.js';
import {
    useTuiClipboard,
    useTuiLocalPreferences,
    useTuiPromptStash,
    useTuiToast,
} from '../platform/providers/index.js';
import { useTerminalViewport } from '../platform/terminal-viewport-solid.js';
import { useSolidStoreSelector } from '../platform/use-solid-store-selector.js';
import type { AbgOverlayController } from '../state/abg-overlay-controller.js';
import type { ChatAppActions } from '../state/chat-app-actions.js';
import type { ChatStore } from '../state/chat-store.js';
import {
    resolveSlashCommandMenuInsertText,
    resolveWorkflowCommandMenuInsertText,
} from '../state/interactive-chat-command-menu.js';
import type { MissionControlServicesLike } from '../state/mission-services-types.js';
import type { WelcomeData } from '../state/welcome-data-types.js';
import { AbgMinimap } from './AbgMinimap.js';
import { ABG_OVERLAY_TABS, AbgOverlay, type AbgOverlayTab } from './AbgOverlay.js';
import { ChatBottomDock } from './ChatBottomDock.js';
import { type ChatTextareaHandle } from './ChatInputTextarea.js';
import { type ChatScrollboxHandle, ChatTranscript } from './ChatTranscript.js';
import {
    parseModelPreferenceKeys,
    preserveBlockReferences,
    promptPanelRepaintKey,
    recentModelPreferenceSelections,
} from './chat-app/chat-app-helpers.js';
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
    readonly textareaRef: (renderable: TextareaRenderable) => void;
    readonly scrollboxRef: (renderable: ScrollBoxRenderable) => void;
    readonly statusBarProps?: StatusBarProps;
    readonly welcomeData?: WelcomeData;
    readonly abgOverlayController?: AbgOverlayController;
    readonly missionControlServices?: MissionControlServicesLike;
    readonly actions?: ChatAppActions;
};

export function ChatApp({
    store,
    textareaRef,
    scrollboxRef,
    statusBarProps,
    welcomeData,
    abgOverlayController,
    missionControlServices,
    actions,
}: ChatAppProps): JSX.Element {
    const snapshot = useSolidStoreSelector(store, (state) => state);
    let textarea: TextareaRenderable | undefined;
    let scrollbox: ScrollBoxRenderable | undefined;
    const textareaHandle: ChatTextareaHandle = {
        get: () => textarea,
        set: (renderable) => {
            textarea = renderable;
            textareaRef(renderable);
        },
    };
    const scrollboxHandle: ChatScrollboxHandle = {
        get: () => scrollbox,
        set: (renderable) => {
            scrollbox = renderable;
            scrollboxRef(renderable);
        },
    };
    const keymapScrollboxRef = {
        get current(): ScrollBoxRenderable | null {
            return scrollbox ?? null;
        },
    };

    // Seeded from persisted prefs so a user's last tab/scroll survives an overlay reopen.
    const initialPrefs = store.getAbgOverlayPrefsSnapshot();
    const [abgActiveTab, setAbgActiveTab] = createSignal(initialPrefs.activeTabIndex);
    const [abgScrollOffset, setAbgScrollOffset] = createSignal(initialPrefs.scrollOffset);

    const keymap = useKeymap();
    const renderer = useRenderer();
    const clipboard = useTuiClipboard();
    const toast = useTuiToast();
    const promptStash = useTuiPromptStash();
    const localPreferences = useTuiLocalPreferences();
    const viewport = useTerminalViewport();
    const dockPolicy = createMemo(() => bottomDockPolicy(viewport()));
    const promptMenuInteractionsEnabled = createMemo(() => dockPolicy().menu.rows > 0);

    createEffect(() => {
        const noticeId = snapshot().transientNotice?.id;
        const noticeMessage = snapshot().transientNotice?.message;
        if (noticeId !== undefined && noticeMessage !== undefined) {
            toast.show({ message: noticeMessage, variant: 'info' });
        }
    });

    // Read-only mouse-up hook: when a drag-selection exists, surface the
    // keyboard-copy hint. The copy itself stays keyboard-only (Ctrl+D).
    const handleSelectionMouseUp = (): void => {
        const selection = renderer.getSelection();
        if (selection === null) return;
        if (selection.getSelectedText().length === 0) return;
        toast.show({ message: 'Copy selection: Ctrl+D', variant: 'info' });
    };

    let handleSubmit = (): void => {};
    let submitting = false;

    // Wire the submit handler the chat.submit keymap layer (T3) invokes. The
    // keymap owns the return/kpenter chord (native keyBindings are suspended),
    // so this is the sole Enter-submit path. Mirrors ChatInputArea.handleSubmit's
    // IME-safe double-defer + re-entrancy guard + empty check.
    handleSubmit = (): void => {
        if (submitting) return;
        submitting = true;
        const captured = textareaHandle.get()?.plainText ?? '';
        setTimeout(() => {
            setTimeout(() => {
                try {
                    if (captured.trim() === '') return;
                    const snap = store.getSnapshot();
                    if (promptMenuInteractionsEnabled() && captured.startsWith('#')) {
                        const insertText = resolveWorkflowCommandMenuInsertText(
                            captured,
                            snap.menuState,
                            snap.workflowNames,
                        );
                        if (insertText !== undefined) {
                            textareaHandle.get()?.setText(insertText);
                            textareaHandle.get()?.gotoBufferEnd();
                            store.setInputMirror(insertText);
                            return;
                        }
                    }

                    if (promptMenuInteractionsEnabled() && captured.startsWith('/')) {
                        const insertText = resolveSlashCommandMenuInsertText(captured, snap.menuState);
                        if (insertText !== undefined && insertText.trimEnd() !== captured.trimEnd()) {
                            textareaHandle.get()?.setText(insertText);
                            textareaHandle.get()?.gotoBufferEnd();
                            store.setInputMirror(insertText);
                            return;
                        }
                    }

                    store.submitLine(captured);
                    textareaHandle.get()?.clear();
                } finally {
                    submitting = false;
                }
            }, 0);
        }, 0);
    };

    useKeyboard((key) => {
        const isCtrlC = key.ctrl && key.name === 'c';
        if (isCtrlC) {
            const snap = store.getSnapshot();
            // While streaming, Ctrl+C stops the agent rather than clearing the draft.
            if (snap.generating) {
                store.sendInterrupt('ctrl-c');
                return;
            }
            const text = textareaHandle.get()?.plainText ?? snap.inputMirror;
            if (text.length > 0) {
                textareaHandle.get()?.clear();
                store.setInputMirror('');
                return;
            }
            store.sendInterrupt('ctrl-c');
            return;
        }
        // Global sink is overlay-only: when the textarea holds focus, its onKeyDown
        // (in ChatInputArea) owns chords like Ctrl+G. Without this guard, the opening
        // Ctrl+G would double-toggle: textarea opens the overlay, then this sink reads
        // the updated snapshot and immediately closes it.
        if (textareaHandle.get()?.focused) {
            return;
        }
        const snap = store.getSnapshot();
        if (snap.overlayMode === 'abg') {
            if (key.name === 'escape' || (key.ctrl && key.name === 'g')) {
                key.preventDefault();
                store.toggleAbgOverlay();
                return;
            }
            if (key.name >= '1' && key.name <= '8') {
                const idx = Number.parseInt(key.name, 10) - 1;
                setAbgActiveTab(idx);
                setAbgScrollOffset(0);
                return;
            }
            if (key.name === 'tab') {
                setAbgActiveTab((i) => (i + 1) % ABG_OVERLAY_TABS.length);
                setAbgScrollOffset(0);
                return;
            }
            if (key.name === 'up') {
                setAbgScrollOffset((o) => o + 1);
                return;
            }
            if (key.name === 'down') {
                setAbgScrollOffset((o) => Math.max(0, o - 1));
                return;
            }
            if (key.name === 'r' && abgOverlayController !== undefined) {
                abgOverlayController.flushNow();
                return;
            }
            if (key.name === 'c' && abgOverlayController !== undefined) {
                abgOverlayController.clearTimeline();
                return;
            }
        }
        if (snap.overlayMode === 'diff-viewer') {
            const model = buildDiffViewerModel(snap.diffViewerEntries);
            const cursor = snap.diffViewerCursor;
            if (key.name === 'escape' || key.name === 'q') {
                key.preventDefault();
                store.hideDiffViewer();
                return;
            }
            if (key.name === 'j') {
                key.preventDefault();
                store.setDiffViewerCursor(moveLine(model, cursor, 1));
                return;
            }
            if (key.name === 'k') {
                key.preventDefault();
                store.setDiffViewerCursor(moveLine(model, cursor, -1));
                return;
            }
            if (key.name === ']') {
                key.preventDefault();
                store.setDiffViewerCursor(nextHunk(model, cursor));
                return;
            }
            if (key.name === '[') {
                key.preventDefault();
                store.setDiffViewerCursor(prevHunk(model, cursor));
                return;
            }
            if (key.name === 'n') {
                key.preventDefault();
                store.setDiffViewerCursor(nextFile(model, cursor));
                return;
            }
            if (key.name === 'p') {
                key.preventDefault();
                store.setDiffViewerCursor(prevFile(model, cursor));
                return;
            }
        }
    });

    // Managed textarea + chat submit layer (T3): suspends native keyBindings so keys are not double-processed; dynamically imported to keep @opentui/keymap FFI out of --no-tui.
    onMount(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/keymap-managed-layer.js').then(
            ({ registerChatSubmitLayer, registerManagedTextareaComposition }) => {
                if (disposed) return;
                const offComposition = registerManagedTextareaComposition(keymap, renderer);
                const submitHandler = (): void => handleSubmit();
                const offSubmit = registerChatSubmitLayer(keymap, renderer, submitHandler);
                cleanup = (): void => {
                    offSubmit();
                    offComposition();
                };
            },
        );
        onCleanup(() => {
            disposed = true;
            cleanup?.();
        });
    });

    // menu-navigation layer: priority 200 shadows the managed textarea layer for
    // Up/Down while a `/`, `#`, or `@`-file autocomplete menu is open. Without it
    // the textarea layer binds arrows to cursor movement and returns handled,
    // stopping propagation before ChatInputArea.handleKeyDown can navigate menus.
    onMount(() => {
        const offLayer = keymap.registerLayer({
            priority: 200,
            enabled: (): boolean => {
                if (!promptMenuInteractionsEnabled()) {
                    return false;
                }
                const text = textareaHandle.get()?.plainText ?? '';
                if (text.startsWith('/') || text.startsWith('#')) {
                    const token = text.slice(1);
                    return !token.includes(' ') && !token.includes('\n') && !token.includes('\t');
                }
                const snap = store.getSnapshot();
                return snap.fileAutocomplete.open;
            },
            commands: [
                {
                    name: 'menu.up',
                    run: () => {
                        const text = textareaHandle.get()?.plainText ?? '';
                        const snap = store.getSnapshot();
                        if (text.startsWith('/')) {
                            store.navigateSlashMenu('up');
                        } else if (text.startsWith('#')) {
                            store.navigateWorkflowMenu('up');
                        } else if (snap.fileAutocomplete.open) {
                            store.navigateFileAutocomplete('up');
                        }
                        return true;
                    },
                },
                {
                    name: 'menu.down',
                    run: () => {
                        const text = textareaHandle.get()?.plainText ?? '';
                        const snap = store.getSnapshot();
                        if (text.startsWith('/')) {
                            store.navigateSlashMenu('down');
                        } else if (text.startsWith('#')) {
                            store.navigateWorkflowMenu('down');
                        } else if (snap.fileAutocomplete.open) {
                            store.navigateFileAutocomplete('down');
                        }
                        return true;
                    },
                },
            ],
            bindings: [
                { key: 'up', cmd: 'menu.up' },
                { key: 'down', cmd: 'menu.down' },
            ],
        });
        onCleanup(offLayer);
    });

    // messages.* scroll + copy layer (T10): SESSION-scoped (not textarea-gated); clipboard built from the renderer (OSC52 via opentui native core).
    onMount(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/messages-scroll.js').then(({ registerMessagesScrollLayer }) => {
            if (disposed) return;
            cleanup = registerMessagesScrollLayer(
                keymap,
                {
                    scrollboxRef: keymapScrollboxRef,
                    clipboardService: clipboard,
                    getViewportRows: () => viewport().rows,
                    getLastAssistantText: () => extractLastAssistantText(store.getSnapshot().outputText),
                    getSelectionText: () => renderer.getSelection()?.getSelectedText() ?? '',
                    clearSelection: () => renderer.clearSelection(),
                },
                { isEnabled: () => store.getSnapshot().overlayMode === 'none' },
            );
        });
        onCleanup(() => {
            disposed = true;
            cleanup?.();
        });
    });

    // selection.copy layer: high-priority + selection-gated, so the default
    // ctrl+d copies a drag-selection but still deletes a char when nothing is
    // selected. Same OSC52 path + deps as the scroll layer above.
    onMount(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/messages-scroll.js').then(({ registerSelectionCopyLayer }) => {
            if (disposed) return;
            cleanup = registerSelectionCopyLayer(
                keymap,
                {
                    scrollboxRef: keymapScrollboxRef,
                    clipboardService: clipboard,
                    getViewportRows: () => viewport().rows,
                    getLastAssistantText: () => extractLastAssistantText(store.getSnapshot().outputText),
                    getSelectionText: () => renderer.getSelection()?.getSelectedText() ?? '',
                    clearSelection: () => renderer.clearSelection(),
                },
                { isEnabled: () => store.getSnapshot().overlayMode === 'none' },
            );
        });
        onCleanup(() => {
            disposed = true;
            cleanup?.();
        });
    });

    // model-shortcuts layer (T11): F2/leader+N; selectModel routes through store.onModelCycleSelect (same path as Ctrl+P).
    onMount(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/model-favorites.js').then(
            ({
                createPreferenceBackedModelFavorites,
                createPreferenceBackedModelFrecency,
                registerModelShortcutsLayer,
            }) => {
                if (disposed) return;
                cleanup = registerModelShortcutsLayer(keymap, {
                    frecency: createPreferenceBackedModelFrecency({
                        getRecentModels: () =>
                            recentModelPreferenceSelections(localPreferences.preferences().recentModels),
                        recordRecentModel: (selection) => {
                            void localPreferences.addRecentModel(selection);
                        },
                    }),
                    favorites: createPreferenceBackedModelFavorites({
                        getFavoriteModels: () =>
                            parseModelPreferenceKeys(localPreferences.preferences().favoriteModels),
                    }),
                    getModelSelections: () => store.getSnapshot().modelCycleChoices.map((choice) => choice.selection),
                    getCurrentSelection: () => {
                        const snap = store.getSnapshot();
                        return snap.modelCycleChoices[snap.modelCycleIndex]?.selection;
                    },
                    selectModel: (selection) => {
                        store.setModelSelection(selection);
                    },
                    emitNotice: (text) => {
                        store.emitOutput(text);
                    },
                });
            },
        );
        onCleanup(() => {
            disposed = true;
            cleanup?.();
        });
    });

    // session-shortcuts layer (T12): session-tree nav + prompt stash; priority -100 so bare arrows yield to editing while focused.
    onMount(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/session-shortcuts.js').then(({ registerSessionShortcutsLayer }) => {
            if (disposed) return;
            cleanup = registerSessionShortcutsLayer(
                keymap,
                {
                    navigateSessionTree: () => store.sendSlashCommand('/tree'),
                    captureInput: () => ({
                        text: textareaHandle.get()?.plainText ?? '',
                        cursor: textareaHandle.get()?.cursorOffset ?? 0,
                    }),
                    clearInput: () => {
                        textareaHandle.get()?.clear();
                        store.setInputMirror('');
                    },
                    restoreInput: (entry) => {
                        const textarea = textareaHandle.get();
                        if (textarea !== undefined) {
                            textarea.setText(entry.text);
                            textarea.cursorOffset = entry.cursor;
                        }
                        store.setInputMirror(entry.text);
                    },
                    emitNotice: (text) => {
                        store.emitOutput(text);
                    },
                },
                {
                    isEnabled: () => store.getSnapshot().overlayMode === 'none',
                    promptStashService: {
                        count: () => promptStash.entries().length,
                        pushDraft: async (entry) => {
                            await promptStash.pushDraft({ text: entry.text, cursorOffset: entry.cursor });
                        },
                        popDraft: async () => {
                            const entry = await promptStash.popDraft();
                            return entry === undefined ? undefined : { text: entry.text, cursor: entry.cursorOffset };
                        },
                    },
                },
            );
        });
        onCleanup(() => {
            disposed = true;
            cleanup?.();
        });
    });

    // message undo/redo layer (T15): leader+u/r hides/restores the last exchange in the VIEW only (durable session store untouched); single-level.
    onMount(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/message-undo-redo.js').then(({ registerMessageUndoRedoLayer }) => {
            if (disposed) return;
            cleanup = registerMessageUndoRedoLayer(keymap, {
                getOutputText: () => store.getSnapshot().outputText,
                replaceOutputText: (text) => store.replaceOutputText(text),
                isGenerating: () => store.getSnapshot().generating,
                emitNotice: (text) => {
                    store.emitOutput(text);
                },
            });
        });
        onCleanup(() => {
            disposed = true;
            cleanup?.();
        });
    });

    // ABG minimap toggle layer: <leader>g (Ctrl+X then G) toggles the compact
    // upper-right minimap. Enabled only when no overlay is active so the chord
    // does not fire inside the full ABG overlay (which has its own Ctrl+G close).
    onMount(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/leader-addons.js').then(({ registerAbgMinimapToggleLayer }) => {
            if (disposed) return;
            cleanup = registerAbgMinimapToggleLayer(keymap, {
                toggleMinimap: () => store.toggleAbgMinimap(),
                isEnabled: () => store.getSnapshot().overlayMode === 'none',
            });
        });
        onCleanup(() => {
            disposed = true;
            cleanup?.();
        });
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

    // opentui's double-buffer diff can miss cells when a wide character (Korean
    // Hangul, emoji) is replaced by a narrow one — the continuation cell is not
    // marked dirty, leaving stale pixels that look like garbled text. Force a
    // full repaint (skip the diff, write every cell) when the view changes
    // dramatically: viewport resize, overlay open/close, and when a streaming
    // response finishes.
    let prevViewport = viewport();
    createEffect(() => {
        const currentViewport = viewport();
        if (prevViewport.columns !== currentViewport.columns || prevViewport.rows !== currentViewport.rows) {
            prevViewport = currentViewport;
            hardResetRendererSurface(renderer);
        }
    });

    let prevOverlayMode = snapshot().overlayMode;
    createEffect(() => {
        if (prevOverlayMode !== snapshot().overlayMode) {
            prevOverlayMode = snapshot().overlayMode;
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        }
    });

    let prevPromptRepaintKey = promptRepaintKey();
    createEffect(() => {
        if (prevPromptRepaintKey !== promptRepaintKey()) {
            prevPromptRepaintKey = promptRepaintKey();
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        }
    });

    let prevGenerating = snapshot().generating;
    createEffect(() => {
        if (prevGenerating && !snapshot().generating) {
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        }
        prevGenerating = snapshot().generating;
    });

    // During streaming, opentui's cell-diff can miss wide-character continuation
    // cells on every incremental text update. A periodic full repaint corrects
    // the accumulated errors without the per-frame cost of always skipping diff.
    createEffect(() => {
        if (!snapshot().generating) return;
        const timer = setInterval(() => {
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        }, 500);
        onCleanup(() => clearInterval(timer));
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

            const selection = snap.currentModelSelection;
            const providerID = selection?.providerID ?? statusBarProps?.providerID ?? '';
            const modelID = selection?.modelID ?? statusBarProps?.modelID ?? '';
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

        const upperOutputRegion = (
            <>
                {showWelcome() && welcomeData !== undefined ? (
                    <WelcomeScreen
                        data={welcomeData}
                        viewportColumns={viewport().columns}
                        availableRows={dockPolicy().transcript.rows}
                        {...(statusBarProps?.workspaceRoot !== undefined
                            ? { projectLabel: basename(statusBarProps.workspaceRoot) }
                            : {})}
                        {...(statusBarProps?.gitBranch !== undefined ? { gitBranch: statusBarProps.gitBranch } : {})}
                        {...(statusBarProps?.isWorktree !== undefined ? { isWorktree: statusBarProps.isWorktree } : {})}
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
                {...(statusBarProps !== undefined ? { statusBarProps } : {})}
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
                            workspaceRoot={statusBarProps?.workspaceRoot}
                            {...(actions !== undefined ? { actions } : {})}
                        />
                    </ModalPopup>
                ) : null}
                {snap.overlayMode === 'mission-panel' ? (
                    <ModalPopup>
                        <MissionPanelOverlay
                            store={store}
                            workspaceRoot={statusBarProps?.workspaceRoot}
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
