/** @jsxImportSource @opentui/react */

import { type ChatBlock, extractLastAssistantText, parseMessageBlocks } from '@mission-control/tui/chat';
import { type ScrollBoxRenderable, TextAttributes, type TextareaRenderable } from '@opentui/core';
import { useKeymap } from '@opentui/keymap/react';
import { useKeyboard, useRenderer } from '@opentui/react';
import type * as React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
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
import { hardResetRendererSurface } from '../platform/opentui-renderer.js';
import type { TerminalViewport } from '../platform/terminal-viewport.js';
import { useTerminalViewport } from '../platform/terminal-viewport-solid.js';
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
import { ChatTranscript } from './ChatTranscript.js';
import { type BottomDockPolicy, bottomDockPolicy } from './chat-bottom-dock-policy.js';
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
import { type StatusBarProps, statusBarLayoutFromPolicy } from './StatusBar.js';
import { useSpinnerFrame } from './spinner.js';
import { Toast } from './Toast.js';
import { WelcomeScreen } from './WelcomeScreen.js';
import { basename } from 'node:path';

/**
 * Reuse previous block references when content (kind + element-wise lines) is unchanged.
 * Precondition for React.memo on MessageBlock: without reference stability, memo never skips.
 */
export function preserveBlockReferences(fresh: readonly ChatBlock[], prev: readonly ChatBlock[]): readonly ChatBlock[] {
    return fresh.map((block, i) => {
        const old = prev[i];
        if (
            old !== undefined &&
            old.kind === block.kind &&
            old.lines.length === block.lines.length &&
            old.lines.every((line, j) => line === block.lines[j])
        ) {
            return old;
        }
        return block;
    });
}

// Two memos: outer avoids re-parsing when outputText is stable (overlay toggles);
// inner avoids re-comparing when the parse result is stable. prevRef holds the last
// stable result for the next comparison.
function useStableMessageBlocks(outputText: string): readonly ChatBlock[] {
    const prevRef = useRef<readonly ChatBlock[]>([]);
    const fresh = useMemo(() => parseMessageBlocks(outputText), [outputText]);
    const stable = useMemo(() => preserveBlockReferences(fresh, prevRef.current), [fresh]);
    prevRef.current = stable;
    return stable;
}

function AgentSpinner({ text }: { readonly text: string }): React.ReactNode {
    const { glyph } = useSpinnerFrame();
    return (
        <box marginTop={1} flexShrink={0}>
            <text fg="#00ffff">{`${glyph} ${text}`}</text>
        </box>
    );
}

export type PromptPanelRepaintKeyInput = {
    readonly inputMirror: string;
    readonly fileAutocompleteOpen: boolean;
    readonly fileMatchCount: number;
    readonly menuRows: number;
};

export type ChatAppViewportLayout = {
    readonly width: number;
    readonly height: number;
    readonly dockPolicy: BottomDockPolicy;
    readonly welcomeAvailableRows: number;
    readonly promptMenuInteractionsEnabled: boolean;
};

export function bottomDockPolicyForTerminal(viewport: TerminalViewport): BottomDockPolicy {
    return bottomDockPolicy(viewport);
}

export function chatAppViewportLayout(viewport: TerminalViewport): ChatAppViewportLayout {
    const dockPolicy = bottomDockPolicyForTerminal(viewport);
    return {
        width: viewport.columns,
        height: viewport.rows,
        dockPolicy,
        welcomeAvailableRows: dockPolicy.transcript.rows,
        promptMenuInteractionsEnabled: dockPolicy.menu.rows > 0,
    };
}

export function promptPanelRepaintKey(input: PromptPanelRepaintKeyInput): string {
    if (input.menuRows <= 0) return 'none';
    if (input.inputMirror.startsWith('/')) return `slash:${input.inputMirror}`;
    if (input.inputMirror.startsWith('#')) return `workflow:${input.inputMirror}`;
    if (input.fileAutocompleteOpen) return `file:${input.inputMirror}:${input.fileMatchCount}`;
    return 'none';
}

export type ChatAppSplitShellProps = {
    readonly width: number;
    readonly height: number;
    readonly onMouseUp: () => void;
    readonly upperOutputRegion: React.ReactNode;
    readonly bottomDock: React.ReactNode;
    readonly modalOverlays: React.ReactNode;
};

export function ChatAppSplitShell({
    width,
    height,
    onMouseUp,
    upperOutputRegion,
    bottomDock,
    modalOverlays,
}: ChatAppSplitShellProps): React.ReactNode {
    return (
        // biome-ignore lint/a11y/noStaticElementInteractions: opentui terminal primitive, not a DOM element; mouse-up only surfaces the copy-hint toast.
        <box flexDirection="column" width={width} height={height} shouldFill={true} onMouseUp={onMouseUp}>
            <box flexDirection="column" flexGrow={1} shouldFill={true}>
                {upperOutputRegion}
            </box>
            {bottomDock}
            {modalOverlays}
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
    const viewport = useTerminalViewport();
    const viewportRowsRef = useRef(viewport.rows);
    viewportRowsRef.current = viewport.rows;
    const viewportLayout = useMemo(() => chatAppViewportLayout(viewport), [viewport]);
    const shellWidth = viewportLayout.width;
    const shellHeight = viewportLayout.height;
    const dockPolicy = viewportLayout.dockPolicy;
    const promptMenuInteractionsEnabled = viewportLayout.promptMenuInteractionsEnabled;
    const dockStatusLayout = useMemo(() => statusBarLayoutFromPolicy(dockPolicy), [dockPolicy]);

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
                        if (promptMenuInteractionsEnabled && captured.startsWith('#')) {
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

                        if (promptMenuInteractionsEnabled && captured.startsWith('/')) {
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
    }, [promptMenuInteractionsEnabled, store, textareaRef]);

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
                if (!promptMenuInteractionsEnabled) {
                    return false;
                }
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
    }, [keymap, promptMenuInteractionsEnabled, store, textareaRef]);

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
                    getViewportRows: () => viewportRowsRef.current,
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
                    getViewportRows: () => viewportRowsRef.current,
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

    // message undo/redo layer (T15): leader+u/r hides/restores the last exchange in the VIEW only (durable session store untouched); single-level.
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

    const messageBlocks = useStableMessageBlocks(snapshot.outputText);
    const overlayActive = snapshot.overlayMode !== 'none';
    const showWelcome = welcomeData !== undefined && snapshot.outputText === '' && !overlayActive;
    const promptRepaintKey = promptPanelRepaintKey({
        inputMirror: snapshot.inputMirror,
        fileAutocompleteOpen: snapshot.fileAutocomplete.open,
        fileMatchCount: snapshot.fileAutocomplete.matches.length,
        menuRows: dockPolicy.menu.rows,
    });

    // opentui's double-buffer diff can miss cells when a wide character (Korean
    // Hangul, emoji) is replaced by a narrow one — the continuation cell is not
    // marked dirty, leaving stale pixels that look like garbled text. Force a
    // full repaint (skip the diff, write every cell) when the view changes
    // dramatically: viewport resize, overlay open/close, and when a streaming
    // response finishes.
    const prevViewport = useRef(viewport);
    useEffect(() => {
        if (prevViewport.current.columns !== viewport.columns || prevViewport.current.rows !== viewport.rows) {
            prevViewport.current = viewport;
            hardResetRendererSurface(renderer);
        }
    }, [viewport, renderer]);

    const prevOverlayMode = useRef(snapshot.overlayMode);
    useEffect(() => {
        if (prevOverlayMode.current !== snapshot.overlayMode) {
            prevOverlayMode.current = snapshot.overlayMode;
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        }
    }, [snapshot.overlayMode, renderer]);

    const prevPromptRepaintKey = useRef(promptRepaintKey);
    useEffect(() => {
        if (prevPromptRepaintKey.current !== promptRepaintKey) {
            prevPromptRepaintKey.current = promptRepaintKey;
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        }
    }, [promptRepaintKey, renderer]);

    const prevGenerating = useRef(snapshot.generating);
    useEffect(() => {
        if (prevGenerating.current && !snapshot.generating) {
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        }
        prevGenerating.current = snapshot.generating;
    }, [snapshot.generating, renderer]);

    // During streaming, opentui's cell-diff can miss wide-character continuation
    // cells on every incremental text update. A periodic full repaint corrects
    // the accumulated errors without the per-frame cost of always skipping diff.
    useEffect(() => {
        if (!snapshot.generating) return;
        const timer = setInterval(() => {
            Reflect.set(renderer, 'forceFullRepaintRequested', true);
            renderer.requestRender();
        }, 500);
        return (): void => clearInterval(timer);
    }, [snapshot.generating, renderer]);

    const transcript = (
        <ChatTranscript
            blocks={messageBlocks}
            scrollboxRef={scrollboxRef}
            generating={snapshot.generating}
            toolOutputExpanded={snapshot.toolOutputExpanded}
            viewportColumns={viewport.columns}
        />
    );

    // ModalPopup auto-sizes to content (no `bottom`), so the AgentSpinner's
    // 80ms Braille animation leaks under the popup edge and surfaces as mojibake.
    // Match the 'abg'/'diff-viewer' early-return replacement intent.
    const showAgentIndicator = !overlayActive;

    if (snapshot.overlayMode === 'abg') {
        if (abgOverlayController === undefined) {
            return (
                <box flexDirection="column" width={shellWidth} height={shellHeight} shouldFill={true}>
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
            <box flexDirection="column" width={shellWidth} height={shellHeight} shouldFill={true}>
                <AbgOverlay
                    store={abgOverlayController.store}
                    activeTab={activeTab}
                    scrollOffset={abgScrollOffset}
                    modelLabel={modelLabel}
                    viewport={viewport}
                />
            </box>
        );
    }

    if (snapshot.overlayMode === 'diff-viewer') {
        const entries = snapshot.diffViewerEntries;
        const cursor = snapshot.diffViewerCursor;
        const model = buildDiffViewerModel(entries);
        return (
            <box flexDirection="column" width={shellWidth} height={shellHeight} shouldFill={true}>
                <DiffViewerOverlay entries={entries} model={model} cursor={cursor} />
            </box>
        );
    }

    if (snapshot.overlayMode === 'models-overlay') {
        return (
            <box flexDirection="column" width={shellWidth} height={shellHeight} shouldFill={true}>
                <ModelsOverlay store={store} />
            </box>
        );
    }

    const showAbgMinimap = snapshot.abgMinimapVisible && !overlayActive && abgOverlayController !== undefined;

    return (
        <ChatAppSplitShell
            width={shellWidth}
            height={shellHeight}
            onMouseUp={handleSelectionMouseUp}
            upperOutputRegion={
                <>
                    {showWelcome ? (
                        <WelcomeScreen
                            data={welcomeData}
                            viewportColumns={viewport.columns}
                            availableRows={viewportLayout.welcomeAvailableRows}
                            {...(statusBarProps?.workspaceRoot !== undefined
                                ? { projectLabel: basename(statusBarProps.workspaceRoot) }
                                : {})}
                            {...(statusBarProps?.gitBranch !== undefined
                                ? { gitBranch: statusBarProps.gitBranch }
                                : {})}
                            {...(statusBarProps?.isWorktree !== undefined
                                ? { isWorktree: statusBarProps.isWorktree }
                                : {})}
                        />
                    ) : (
                        transcript
                    )}
                    {showAgentIndicator && snapshot.agentStatusText.length > 0 ? (
                        <AgentSpinner text={snapshot.agentStatusText} />
                    ) : showAgentIndicator && snapshot.generating ? (
                        <AgentSpinner text="Working..." />
                    ) : null}
                    {toast !== null ? <Toast message={toast} /> : null}
                    {showAbgMinimap ? <AbgMinimap store={abgOverlayController.store} viewport={viewport} /> : null}
                </>
            }
            bottomDock={
                <ChatBottomDock
                    store={store}
                    textareaRef={textareaRef}
                    scrollboxRef={scrollboxRef}
                    inputFocused={!overlayActive}
                    viewportColumns={viewport.columns}
                    viewportRows={viewport.rows}
                    statusLayout={dockStatusLayout}
                    menuPolicy={dockPolicy.menu}
                    {...(statusBarProps !== undefined ? { statusBarProps } : {})}
                />
            }
            modalOverlays={
                <>
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
                            <AgentsDashboardOverlay
                                store={store}
                                workspaceRoot={statusBarProps?.workspaceRoot}
                                {...(actions !== undefined ? { actions } : {})}
                            />
                        </ModalPopup>
                    ) : null}
                    {snapshot.overlayMode === 'mission-panel' ? (
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
            }
        />
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
