/** @jsxImportSource @opentui/react */

import { type ScrollBoxRenderable, TextAttributes, type TextareaRenderable } from '@opentui/core';
import { useKeymap } from '@opentui/keymap/react';
import { useKeyboard, useRenderer } from '@opentui/react';
import type * as React from 'react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AbgOverlayController } from '../commands/abg-overlay-controller.js';
import { extractLastAssistantText, parseMessageBlocks } from '../commands/chat-blocks.js';
import type { ChatStore } from '../commands/chat-store.js';
import {
    resolveSlashCommandMenuInsertText,
    resolveWorkflowCommandMenuInsertText,
} from '../commands/interactive-chat-command-menu.js';
import type { MissionControlServices } from '../commands/mission-control-services.js';
import type { WelcomeData } from '../commands/welcome-data.js';
import { createClipboardService } from '../platform/clipboard-service.js';
import {
    buildDiffViewerModel,
    DiffViewerOverlay,
    moveLine,
    nextFile,
    nextHunk,
    prevFile,
    prevHunk,
} from '../platform/keymap/diff-viewer.js';
import { AbgMinimap } from './AbgMinimap.js';
import { ABG_OVERLAY_TABS, AbgOverlay, type AbgOverlayTab } from './AbgOverlay.js';
import { ChatInputArea } from './ChatInputArea.js';
import { ChatTranscript } from './ChatTranscript.js';
import { FileAutocompletePanel } from './FileAutocompletePanel.js';
import { MissionPanelOverlay } from './MissionPanelOverlay.js';
import { ModelsOverlay } from './ModelsOverlay.js';
import { OverlayFrame } from './OverlayFrame.js';
import {
    AgentsDashboardOverlay,
    ApprovalOverlay,
    LevelPickerOverlay,
    ModelPickerOverlay,
    QuestionOverlay,
    RenameOverlay,
    SessionPickerOverlay,
} from './OverlayPanels.js';
import { ACCENTS } from './overlay-theme.js';
import { SlashMenuPanel } from './SlashMenuPanel.js';
import { BottomStatusBar, type StatusBarProps, TopStatusBar } from './StatusBar.js';
import { Toast } from './Toast.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { useSpinnerFrame } from './spinner.js';
import { basename } from 'node:path';

function AgentSpinner({ text }: { readonly text: string }): React.ReactNode {
    const { glyph } = useSpinnerFrame();
    return (
        <box marginTop={1} flexShrink={0}>
            <text fg="#00ffff">{`${glyph} ${text}`}</text>
        </box>
    );
}

export type ChatAppProps = {
    readonly store: ChatStore;
    readonly textareaRef: React.RefObject<TextareaRenderable | null>;
    readonly scrollboxRef: React.RefObject<ScrollBoxRenderable | null>;
    readonly statusBarProps?: StatusBarProps;
    readonly welcomeData?: WelcomeData;
    readonly abgOverlayController?: AbgOverlayController;
    readonly missionControlServices?: MissionControlServices;
};

export function ChatApp({
    store,
    textareaRef,
    scrollboxRef,
    statusBarProps,
    welcomeData,
    abgOverlayController,
    missionControlServices,
}: ChatAppProps): React.ReactNode {
    const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
    const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
    const snapshot = useSyncExternalStore(subscribe, getSnapshot);

    // Seeded from persisted prefs so a user's last tab/scroll survives an overlay reopen.
    const initialPrefs = store.getAbgOverlayPrefsSnapshot();
    const [abgActiveTab, setAbgActiveTab] = useState<number>(initialPrefs.activeTabIndex);
    const [abgScrollOffset, setAbgScrollOffset] = useState<number>(initialPrefs.scrollOffset);

    const keymap = useKeymap();
    const renderer = useRenderer();

    // Transient toast (e.g. the selection-copy hint). Local state — presentational,
    // does not flow through ChatStore. Auto-dismisses; re-showing resets the timer.
    const [toast, setToast] = useState<string | null>(null);
    const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const showToast = useCallback((message: string): void => {
        setToast(message);
        if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
        toastTimerRef.current = setTimeout(() => {
            setToast(null);
            toastTimerRef.current = null;
        }, 3000);
    }, []);
    useEffect(() => {
        return (): void => {
            if (toastTimerRef.current !== null) clearTimeout(toastTimerRef.current);
        };
    }, []);

    const noticeId = snapshot.transientNotice?.id;
    const noticeMessage = snapshot.transientNotice?.message;
    useEffect(() => {
        if (noticeId !== undefined && noticeMessage !== undefined) {
            showToast(noticeMessage);
        }
    }, [noticeId, noticeMessage, showToast]);

    // Read-only mouse-up hook: when a drag-selection exists, surface the
    // keyboard-copy hint. The copy itself stays keyboard-only (Ctrl+D).
    const handleSelectionMouseUp = useCallback((): void => {
        const selection = renderer.getSelection();
        if (selection === null) return;
        if (selection.getSelectedText().length === 0) return;
        showToast('Copy selection: Ctrl+D');
    }, [renderer, showToast]);

    const handleSubmitRef = useRef<() => void>(() => {});
    const submittingRef = useRef(false);

    // Wire the submit handler the chat.submit keymap layer (T3) invokes. The
    // keymap owns the return/kpenter chord (native keyBindings are suspended),
    // so this is the sole Enter-submit path. Mirrors ChatInputArea.handleSubmit's
    // IME-safe double-defer + re-entrancy guard + empty check.
    useEffect(() => {
        handleSubmitRef.current = (): void => {
            if (submittingRef.current) return;
            submittingRef.current = true;
            const captured = textareaRef.current?.plainText ?? '';
            setTimeout(() => {
                setTimeout(() => {
                    try {
                        if (captured.trim() === '') return;
                        const snap = store.getSnapshot();

                        if (captured.startsWith('#')) {
                            const insertText = resolveWorkflowCommandMenuInsertText(
                                captured,
                                snap.menuState,
                                snap.workflowNames,
                            );
                            if (insertText !== undefined) {
                                textareaRef.current?.setText(insertText);
                                textareaRef.current?.gotoBufferEnd();
                                store.setInputMirror(insertText);
                                return;
                            }
                        }

                        if (captured.startsWith('/')) {
                            const insertText = resolveSlashCommandMenuInsertText(captured, snap.menuState);
                            if (insertText !== undefined && insertText.trimEnd() !== captured.trimEnd()) {
                                textareaRef.current?.setText(insertText);
                                textareaRef.current?.gotoBufferEnd();
                                store.setInputMirror(insertText);
                                return;
                            }
                        }

                        store.submitLine(captured);
                        textareaRef.current?.clear();
                    } finally {
                        submittingRef.current = false;
                    }
                }, 0);
            }, 0);
        };
    }, [store, textareaRef]);

    useKeyboard((key) => {
        const isCtrlC = key.ctrl && key.name === 'c';
        if (isCtrlC) {
            const snap = store.getSnapshot();
            // While streaming, Ctrl+C stops the agent rather than clearing the draft.
            if (snap.generating) {
                store.sendInterrupt('ctrl-c');
                return;
            }
            const text = textareaRef.current?.plainText ?? snap.inputMirror;
            if (text.length > 0) {
                textareaRef.current?.clear();
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
        if (textareaRef.current?.focused) {
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
    useEffect(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/keymap-managed-layer.js').then(
            ({ registerChatSubmitLayer, registerManagedTextareaComposition }) => {
                if (disposed) return;
                const offComposition = registerManagedTextareaComposition(keymap, renderer);
                const submitHandler = (): void => handleSubmitRef.current();
                const offSubmit = registerChatSubmitLayer(keymap, renderer, submitHandler);
                cleanup = (): void => {
                    offSubmit();
                    offComposition();
                };
            },
        );
        return (): void => {
            disposed = true;
            cleanup?.();
        };
    }, [keymap, renderer]);

    // menu-navigation layer: priority 200 shadows the managed textarea layer for
    // Up/Down while a `/`, `#`, or `@`-file autocomplete menu is open. Without it
    // the textarea layer binds arrows to cursor movement and returns handled,
    // stopping propagation before ChatInputArea.handleKeyDown can navigate menus.
    useEffect(() => {
        const offLayer = keymap.registerLayer({
            priority: 200,
            enabled: (): boolean => {
                const text = textareaRef.current?.plainText ?? '';
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
                        const text = textareaRef.current?.plainText ?? '';
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
                        const text = textareaRef.current?.plainText ?? '';
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
        return offLayer;
    }, [keymap, store, textareaRef]);

    // messages.* scroll + copy layer (T10): SESSION-scoped (not textarea-gated); clipboard built from the renderer (OSC52 via opentui native core).
    useEffect(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/messages-scroll.js').then(({ registerMessagesScrollLayer }) => {
            if (disposed) return;
            cleanup = registerMessagesScrollLayer(
                keymap,
                {
                    scrollboxRef,
                    clipboardService: createClipboardService(renderer),
                    getLastAssistantText: () => extractLastAssistantText(store.getSnapshot().outputText),
                    getSelectionText: () => renderer.getSelection()?.getSelectedText() ?? '',
                    clearSelection: () => renderer.clearSelection(),
                },
                { isEnabled: () => store.getSnapshot().overlayMode === 'none' },
            );
        });
        return (): void => {
            disposed = true;
            cleanup?.();
        };
    }, [keymap, renderer, scrollboxRef, store]);

    // selection.copy layer: high-priority + selection-gated, so the default
    // ctrl+d copies a drag-selection but still deletes a char when nothing is
    // selected. Same OSC52 path + deps as the scroll layer above.
    useEffect(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/messages-scroll.js').then(({ registerSelectionCopyLayer }) => {
            if (disposed) return;
            cleanup = registerSelectionCopyLayer(
                keymap,
                {
                    scrollboxRef,
                    clipboardService: createClipboardService(renderer),
                    getLastAssistantText: () => extractLastAssistantText(store.getSnapshot().outputText),
                    getSelectionText: () => renderer.getSelection()?.getSelectedText() ?? '',
                    clearSelection: () => renderer.clearSelection(),
                },
                { isEnabled: () => store.getSnapshot().overlayMode === 'none' },
            );
        });
        return (): void => {
            disposed = true;
            cleanup?.();
        };
    }, [keymap, renderer, scrollboxRef, store]);

    // model-shortcuts layer (T11): F2/leader+N; selectModel routes through store.onModelCycleSelect (same path as Ctrl+P).
    useEffect(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/model-favorites.js').then(
            ({ ModelFrecency, ModelFavorites, registerModelShortcutsLayer }) => {
                if (disposed) return;
                cleanup = registerModelShortcutsLayer(keymap, {
                    frecency: new ModelFrecency(),
                    favorites: new ModelFavorites(),
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
        return (): void => {
            disposed = true;
            cleanup?.();
        };
    }, [keymap, store]);

    // session-shortcuts layer (T12): session-tree nav + prompt stash; priority -100 so bare arrows yield to editing while focused.
    useEffect(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/session-shortcuts.js').then(({ registerSessionShortcutsLayer }) => {
            if (disposed) return;
            cleanup = registerSessionShortcutsLayer(
                keymap,
                {
                    navigateSessionTree: () => store.sendSlashCommand('/tree'),
                    captureInput: () => ({
                        text: textareaRef.current?.plainText ?? '',
                        cursor: textareaRef.current?.cursorOffset ?? 0,
                    }),
                    clearInput: () => {
                        textareaRef.current?.clear();
                        store.setInputMirror('');
                    },
                    restoreInput: (entry) => {
                        const textarea = textareaRef.current;
                        if (textarea !== null) {
                            textarea.setText(entry.text);
                            textarea.cursorOffset = entry.cursor;
                        }
                        store.setInputMirror(entry.text);
                    },
                    emitNotice: (text) => {
                        store.emitOutput(text);
                    },
                },
                { isEnabled: () => store.getSnapshot().overlayMode === 'none' },
            );
        });
        return (): void => {
            disposed = true;
            cleanup?.();
        };
    }, [keymap, store, textareaRef]);

    // message undo/redo layer (T15): leader+u/r hides/restores the last exchange in the VIEW only (durable JSONL untouched); single-level.
    useEffect(() => {
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
        return (): void => {
            disposed = true;
            cleanup?.();
        };
    }, [keymap, store]);

    // ABG minimap toggle layer: <leader>g (Ctrl+X then G) toggles the compact
    // upper-right minimap. Enabled only when no overlay is active so the chord
    // does not fire inside the full ABG overlay (which has its own Ctrl+G close).
    useEffect(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/leader-addons.js').then(({ registerAbgMinimapToggleLayer }) => {
            if (disposed) return;
            cleanup = registerAbgMinimapToggleLayer(keymap, {
                toggleMinimap: () => store.toggleAbgMinimap(),
                isEnabled: () => store.getSnapshot().overlayMode === 'none',
            });
        });
        return (): void => {
            disposed = true;
            cleanup?.();
        };
    }, [keymap, store]);

    const messageBlocks = parseMessageBlocks(snapshot.outputText);
    const overlayActive = snapshot.overlayMode !== 'none';
    const showWelcome = welcomeData !== undefined && snapshot.outputText === '' && !overlayActive;

    // opentui's double-buffer diff can miss cells when a wide character (Korean
    // Hangul, emoji) is replaced by a narrow one — the continuation cell is not
    // marked dirty, leaving stale pixels that look like garbled text. Force a
    // full repaint (skip the diff, write every cell) when the view changes
    // dramatically: overlay open/close, and when a streaming response finishes.
    const prevOverlayMode = useRef(snapshot.overlayMode);
    useEffect(() => {
        if (prevOverlayMode.current !== snapshot.overlayMode) {
            prevOverlayMode.current = snapshot.overlayMode;
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        }
    }, [snapshot.overlayMode, renderer]);

    const prevGenerating = useRef(snapshot.generating);
    useEffect(() => {
        if (prevGenerating.current && !snapshot.generating) {
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        }
        prevGenerating.current = snapshot.generating;
    }, [snapshot.generating, renderer]);

    const transcript = (
        <ChatTranscript
            blocks={messageBlocks}
            scrollboxRef={scrollboxRef}
            generating={snapshot.generating}
            toolOutputExpanded={snapshot.toolOutputExpanded}
        />
    );

    // ModalPopup auto-sizes to content (no `bottom`), so the AgentSpinner's
    // 80ms Braille animation leaks under the popup edge and surfaces as mojibake.
    // Match the 'abg'/'diff-viewer' early-return replacement intent.
    const showAgentIndicator = !overlayActive;

    if (snapshot.overlayMode === 'abg') {
        if (abgOverlayController === undefined) {
            return (
                <box flexDirection="column" width="100%" height="100%" shouldFill={true}>
                    <OverlayFrame variant="view" title="ABG Overlay" hint="(Ctrl+G or Esc to close)">
                        <text attributes={TextAttributes.DIM}>{'ABG overlay unavailable in this session.'}</text>
                    </OverlayFrame>
                </box>
            );
        }
        const selection = snapshot.currentModelSelection;
        const providerID = selection?.providerID ?? statusBarProps?.providerID ?? '';
        const modelID = selection?.modelID ?? statusBarProps?.modelID ?? '';
        const variantID = snapshot.currentModelVariantID;
        const modelLabel = `${providerID}/${modelID}${variantID !== undefined ? `#${variantID}` : ''}`;
        const activeTab: AbgOverlayTab = ABG_OVERLAY_TABS[abgActiveTab] ?? 'overview';
        return (
            <box flexDirection="column" width="100%" height="100%" shouldFill={true}>
                <AbgOverlay
                    store={abgOverlayController.store}
                    activeTab={activeTab}
                    scrollOffset={abgScrollOffset}
                    modelLabel={modelLabel}
                />
            </box>
        );
    }

    if (snapshot.overlayMode === 'diff-viewer') {
        const entries = snapshot.diffViewerEntries;
        const cursor = snapshot.diffViewerCursor;
        const model = buildDiffViewerModel(entries);
        return (
            <box flexDirection="column" width="100%" height="100%" shouldFill={true}>
                <DiffViewerOverlay entries={entries} model={model} cursor={cursor} />
            </box>
        );
    }

    if (snapshot.overlayMode === 'models-overlay') {
        return (
            <box flexDirection="column" width="100%" height="100%" shouldFill={true}>
                <ModelsOverlay store={store} />
            </box>
        );
    }

    const showSlashMenu = snapshot.inputMirror.startsWith('/');
    const showWorkflowMenu = snapshot.inputMirror.startsWith('#');
    const showFileAutocomplete = !showSlashMenu && !showWorkflowMenu && snapshot.fileAutocomplete.open;

    const showAbgMinimap = snapshot.abgMinimapVisible && !overlayActive && abgOverlayController !== undefined;

    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: opentui terminal primitive, not a DOM element; mouse-up only surfaces the copy-hint toast.
        <box flexDirection="column" width="100%" height="100%" onMouseUp={handleSelectionMouseUp}>
            <box flexDirection="column" flexGrow={1}>
                {showWelcome ? (
                    <WelcomeScreen
                        data={welcomeData}
                        {...(statusBarProps?.workspaceRoot !== undefined
                            ? { projectLabel: basename(statusBarProps.workspaceRoot) }
                            : {})}
                        {...(statusBarProps?.gitBranch !== undefined ? { gitBranch: statusBarProps.gitBranch } : {})}
                        {...(statusBarProps?.isWorktree !== undefined ? { isWorktree: statusBarProps.isWorktree } : {})}
                    />
                ) : (
                    transcript
                )}
                {showAgentIndicator && snapshot.agentStatusText.length > 0 ? (
                    <AgentSpinner text={snapshot.agentStatusText} />
                ) : showAgentIndicator && snapshot.generating ? (
                    <AgentSpinner text="Working..." />
                ) : null}
                {showSlashMenu || showWorkflowMenu ? (
                    <SlashMenuPanel
                        inputBuffer={snapshot.inputMirror}
                        menuState={snapshot.menuState}
                        workflowNames={snapshot.workflowNames}
                    />
                ) : null}
                {showFileAutocomplete ? <FileAutocompletePanel fileAutocomplete={snapshot.fileAutocomplete} /> : null}
                {toast !== null ? <Toast message={toast} /> : null}
            </box>
            {showAbgMinimap ? <AbgMinimap store={abgOverlayController.store} /> : null}
            {statusBarProps !== undefined ? (
                <TopStatusBar
                    {...statusBarProps}
                    {...(snapshot.currentModelSelection?.providerID !== undefined
                        ? { providerID: snapshot.currentModelSelection.providerID }
                        : {})}
                    {...(snapshot.currentModelSelection?.modelID !== undefined
                        ? { modelID: snapshot.currentModelSelection.modelID }
                        : {})}
                    {...(snapshot.currentModelVariantID !== undefined
                        ? { variantID: snapshot.currentModelVariantID }
                        : {})}
                    {...(snapshot.contextTokensUsed !== undefined
                        ? { contextTokensUsed: snapshot.contextTokensUsed }
                        : {})}
                    {...(snapshot.contextTokensMax !== undefined
                        ? { contextTokensMax: snapshot.contextTokensMax }
                        : {})}
                />
            ) : null}
            {snapshot.overlayMode === 'question' ? (
                <QuestionOverlay store={store} />
            ) : (
                <ChatInputArea
                    store={store}
                    textareaRef={textareaRef}
                    scrollboxRef={scrollboxRef}
                    focused={!overlayActive}
                />
            )}
            {statusBarProps !== undefined ? (
                <BottomStatusBar
                    {...statusBarProps}
                    {...(snapshot.sessionId.length > 0 ? { sessionID: snapshot.sessionId } : {})}
                    {...(snapshot.approvalLevel !== undefined ? { approvalLevel: snapshot.approvalLevel } : {})}
                />
            ) : null}
            {snapshot.overlayMode === 'approval' ? (
                <ModalPopup>
                    <ApprovalOverlay store={store} />
                </ModalPopup>
            ) : null}
            {snapshot.overlayMode === 'model-picker' ? (
                <ModalPopup>
                    <ModelPickerOverlay store={store} />
                </ModalPopup>
            ) : null}
            {snapshot.overlayMode === 'level-picker' ? (
                <ModalPopup>
                    <LevelPickerOverlay store={store} />
                </ModalPopup>
            ) : null}
            {snapshot.overlayMode === 'rename' ? (
                <ModalPopup>
                    <RenameOverlay store={store} />
                </ModalPopup>
            ) : null}
            {snapshot.overlayMode === 'session-picker' ? (
                <ModalPopup>
                    <SessionPickerOverlay store={store} />
                </ModalPopup>
            ) : null}
            {snapshot.overlayMode === 'agents-dashboard' ? (
                <ModalPopup>
                    <AgentsDashboardOverlay store={store} workspaceRoot={statusBarProps?.workspaceRoot} />
                </ModalPopup>
            ) : null}
            {snapshot.overlayMode === 'mission-panel' ? (
                <ModalPopup>
                    <MissionPanelOverlay
                        store={store}
                        workspaceRoot={statusBarProps?.workspaceRoot}
                        {...(missionControlServices !== undefined ? { services: missionControlServices } : {})}
                    />
                </ModalPopup>
            ) : null}
        </box>
    );
}

function ModalPopup({ children }: { readonly children: React.ReactNode }): React.ReactNode {
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
