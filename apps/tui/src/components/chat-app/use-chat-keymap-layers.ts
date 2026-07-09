import { extractLastAssistantText } from '@mission-control/tui/chat';
import type { CliRenderer, ScrollBoxRenderable } from '@opentui/core';
import type { Accessor } from 'solid-js';
import { onCleanup, onMount } from 'solid-js';
import type { OpenTuiKeymap } from '../../platform/keymap/keymap-instance.js';
import type { TuiClipboardService } from '../../platform/providers/clipboard-toast-context.js';
import type { TuiLocalPreferencesService } from '../../platform/providers/local-preferences-context.js';
import type { TuiPromptStashService } from '../../platform/providers/prompt-services-context.js';
import type { TerminalViewport } from '../../platform/terminal-viewport.js';
import type { ChatStore } from '../../state/chat-store.js';
import type { ChatTextareaHandle } from '../ChatInputTextarea.js';
import { parseModelPreferenceKeys, recentModelPreferenceSelections } from './chat-app-helpers.js';

/**
 * Shared deps for all ChatApp keymap layer registrations.
 * Frozen for the simplify-tui-mount extract; single registration site per layer.
 */
export type ChatKeymapLayersDeps = {
    readonly store: ChatStore;
    readonly keymap: OpenTuiKeymap;
    readonly renderer: CliRenderer;
    readonly clipboard: TuiClipboardService;
    readonly viewport: Accessor<TerminalViewport>;
    readonly promptStash: TuiPromptStashService;
    readonly localPreferences: TuiLocalPreferencesService;
    readonly textareaHandle: ChatTextareaHandle;
    readonly scrollboxRef: {
        readonly current: ScrollBoxRenderable | null;
    };
    readonly promptMenuInteractionsEnabled: () => boolean;
    readonly handleSubmit: () => void;
};

/**
 * Registers every ChatApp keymap layer exactly once (managed textarea+submit,
 * menu-nav prio 200, messages-scroll, selection-copy, model-shortcuts,
 * session-shortcuts, undo/redo, ABG minimap). Dynamic imports keep
 * `@opentui/keymap` FFI out of the `--no-tui` graph.
 */
export function useChatKeymapLayers(deps: ChatKeymapLayersDeps): void {
    const {
        store,
        keymap,
        renderer,
        clipboard,
        viewport,
        promptStash,
        localPreferences,
        textareaHandle,
        scrollboxRef,
        promptMenuInteractionsEnabled,
        handleSubmit,
    } = deps;

    // Managed textarea + chat submit layer (T3): suspends native keyBindings so keys are not double-processed; dynamically imported to keep @opentui/keymap FFI out of --no-tui.
    onMount(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../../platform/keymap/keymap-managed-layer.js').then(
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
        void import('../../platform/keymap/messages-scroll.js').then(({ registerMessagesScrollLayer }) => {
            if (disposed) return;
            cleanup = registerMessagesScrollLayer(
                keymap,
                {
                    scrollboxRef,
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
        void import('../../platform/keymap/messages-scroll.js').then(({ registerSelectionCopyLayer }) => {
            if (disposed) return;
            cleanup = registerSelectionCopyLayer(
                keymap,
                {
                    scrollboxRef,
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
        void import('../../platform/keymap/model-favorites.js').then(
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
        void import('../../platform/keymap/session-shortcuts.js').then(({ registerSessionShortcutsLayer }) => {
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
        void import('../../platform/keymap/message-undo-redo.js').then(({ registerMessageUndoRedoLayer }) => {
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
        void import('../../platform/keymap/leader-addons.js').then(({ registerAbgMinimapToggleLayer }) => {
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
}
