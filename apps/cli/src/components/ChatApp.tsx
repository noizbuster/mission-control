/** @jsxImportSource @opentui/react */

import { TextAttributes, type ScrollBoxRenderable, type TextareaRenderable } from '@opentui/core';
import { useKeyboard, useRenderer } from '@opentui/react';
import { useKeymap } from '@opentui/keymap/react';
import type * as React from 'react';
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { Banner } from './Banner.js';
import { ChatTranscript } from './ChatTranscript.js';
import { ChatInputArea } from './ChatInputArea.js';
import { SlashMenuPanel } from './SlashMenuPanel.js';
import { FileAutocompletePanel } from './FileAutocompletePanel.js';
import { StatusBar, type StatusBarProps } from './StatusBar.js';
import {
    ApprovalOverlay,
    QuestionOverlay,
    ModelPickerOverlay,
    LevelPickerOverlay,
    RenameOverlay,
    SessionPickerOverlay,
} from './OverlayPanels.js';
import type { ChatStore } from '../commands/chat-store.js';
import { extractLastAssistantText, parseMessageBlocks } from '../commands/chat-blocks.js';
import { createClipboardService } from '../platform/clipboard-service.js';

const SPINNER_FRAMES = '\u280b\u2819\u2839\u2838\u2834\u2826\u2827\u2807';

function AgentSpinner({ text }: { readonly text: string }): React.ReactNode {
    const [frame, setFrame] = useState(0);
    useEffect(() => {
        const timer = setInterval(() => setFrame((f) => (f + 1) % SPINNER_FRAMES.length), 80);
        return (): void => clearInterval(timer);
    }, []);
    const ch = SPINNER_FRAMES[frame] ?? SPINNER_FRAMES[0] ?? '';
    return (
        <box marginTop={1}>
            <text fg="#00ffff">{`${ch} ${text}`}</text>
        </box>
    );
}

export type ChatAppProps = {
    readonly store: ChatStore;
    readonly textareaRef: React.RefObject<TextareaRenderable | null>;
    readonly scrollboxRef: React.RefObject<ScrollBoxRenderable | null>;
    readonly statusBarProps?: StatusBarProps;
};

export function ChatApp({
    store,
    textareaRef,
    scrollboxRef,
    statusBarProps,
}: ChatAppProps): React.ReactNode {
    const subscribe = useCallback((cb: () => void) => store.subscribe(cb), [store]);
    const getSnapshot = useCallback(() => store.getSnapshot(), [store]);
    const snapshot = useSyncExternalStore(subscribe, getSnapshot);

    const keymap = useKeymap();
    const renderer = useRenderer();
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
        }
        if (snap.overlayMode === 'diff-viewer') {
            if (key.name === 'escape' || key.name === 'q') {
                key.preventDefault();
                // The store exposes no hideDiffViewer; hideApproval is the idempotent overlay-clear (sets overlayMode='none' and nothing else).
                store.hideApproval();
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
            cleanup = registerMessagesScrollLayer(keymap, {
                scrollboxRef,
                clipboardService: createClipboardService(renderer),
                getLastAssistantText: () => extractLastAssistantText(store.getSnapshot().outputText),
            });
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
                    getModelSelections: () =>
                        store.getSnapshot().modelCycleChoices.map((choice) => choice.selection),
                    getCurrentSelection: () => {
                        const snap = store.getSnapshot();
                        return snap.modelCycleChoices[snap.modelCycleIndex]?.selection;
                    },
                    selectModel: (selection) => {
                        store.onModelCycleSelect?.(selection);
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
        void import('../platform/keymap/session-shortcuts.js').then(
            ({ registerSessionShortcutsLayer }) => {
                if (disposed) return;
                cleanup = registerSessionShortcutsLayer(keymap, {
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
                });
            },
        );
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

    const messageBlocks = parseMessageBlocks(snapshot.outputText);
    const overlayActive = snapshot.overlayMode !== 'none';

    const transcript = (
        <ChatTranscript
            blocks={messageBlocks}
            scrollboxRef={scrollboxRef}
            generating={snapshot.generating}
            toolOutputExpanded={snapshot.toolOutputExpanded}
        />
    );

    if (snapshot.overlayMode === 'approval') {
        return (
            <box flexDirection="column" width="100%">
                {transcript}
                <ApprovalOverlay store={store} />
            </box>
        );
    }

    if (snapshot.overlayMode === 'question') {
        return (
            <box flexDirection="column" width="100%">
                {transcript}
                <QuestionOverlay store={store} />
            </box>
        );
    }

    if (snapshot.overlayMode === 'model-picker') {
        return (
            <box flexDirection="column" width="100%">
                {transcript}
                <ModelPickerOverlay store={store} />
            </box>
        );
    }

    if (snapshot.overlayMode === 'level-picker') {
        return (
            <box flexDirection="column" width="100%">
                {transcript}
                <LevelPickerOverlay store={store} />
            </box>
        );
    }

    if (snapshot.overlayMode === 'rename') {
        return (
            <box flexDirection="column" width="100%">
                {transcript}
                <RenameOverlay store={store} />
            </box>
        );
    }

    if (snapshot.overlayMode === 'session-picker') {
        return (
            <box flexDirection="column" width="100%">
                {transcript}
                <SessionPickerOverlay store={store} />
            </box>
        );
    }

    if (snapshot.overlayMode === 'abg') {
        return (
            <box flexDirection="column" width="100%">
                <box flexDirection="row" marginTop={1} paddingLeft={1} paddingRight={1}>
                    <text fg="#00ffff" attributes={TextAttributes.BOLD}>{' ABG Overlay '}</text>
                    <text attributes={TextAttributes.DIM}>{' (Ctrl+G or Esc to close)'}</text>
                </box>
                <box flexDirection="column" marginTop={1} paddingLeft={1} paddingRight={1}>
                    <text attributes={TextAttributes.DIM}>{'Tab 0: Overview'}</text>
                    <text attributes={TextAttributes.DIM}>{'The ABG monitoring overlay requires an active agent run.'}</text>
                    <text attributes={TextAttributes.DIM}>{'Start a prompt to see real-time graph/node/tool/timeline data.'}</text>
                </box>
            </box>
        );
    }

    if (snapshot.overlayMode === 'diff-viewer') {
        const diffCount = snapshot.diffViewerEntries.length;
        return (
            <box flexDirection="column" width="100%">
                <box flexDirection="row" marginTop={1} paddingLeft={1} paddingRight={1}>
                    <text fg="#ffff00" attributes={TextAttributes.BOLD}>{' Diff Viewer '}</text>
                    <text attributes={TextAttributes.DIM}>{' (Esc or q to close)'}</text>
                </box>
                <box flexDirection="column" marginTop={1} paddingLeft={1} paddingRight={1}>
                    <text attributes={TextAttributes.DIM}>
                        {diffCount > 0
                            ? `${diffCount} diff entr${diffCount === 1 ? 'y' : 'ies'} staged for review.`
                            : 'No diff entries to display.'}
                    </text>
                </box>
            </box>
        );
    }

    const showSlashMenu = snapshot.inputMirror.startsWith('/');
    const showWorkflowMenu = snapshot.inputMirror.startsWith('#');
    const showFileAutocomplete = !showSlashMenu && !showWorkflowMenu && snapshot.fileAutocomplete.open;

    return (
        <box flexDirection="column" width="100%">
            {statusBarProps !== undefined ? (
                <Banner statusBarProps={statusBarProps} />
            ) : (
                <Banner />
            )}
            {transcript}
            {snapshot.agentStatusText.length > 0 ? (
                <AgentSpinner text={snapshot.agentStatusText} />
            ) : snapshot.generating ? (
                <box marginTop={1}>
                    <text fg="#ffff00">{'\u25cf Thinking...'}</text>
                </box>
            ) : null}
            {showSlashMenu || showWorkflowMenu ? (
                <SlashMenuPanel
                    inputBuffer={snapshot.inputMirror}
                    menuState={snapshot.menuState}
                    workflowNames={snapshot.workflowNames}
                />
            ) : null}
            {showFileAutocomplete ? (
                <FileAutocompletePanel fileAutocomplete={snapshot.fileAutocomplete} />
            ) : null}
            <ChatInputArea
                store={store}
                textareaRef={textareaRef}
                scrollboxRef={scrollboxRef}
                focused={!overlayActive}
            />
            {statusBarProps !== undefined ? (
                <box marginTop={1}>
                    <StatusBar
                        {...statusBarProps}
                        {...(snapshot.approvalLevel !== undefined
                            ? { approvalLevel: snapshot.approvalLevel }
                            : {})}
                    />
                </box>
            ) : null}
        </box>
    );
}
