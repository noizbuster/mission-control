import { extractLastAssistantText } from '@mission-control/tui/chat';
import type { CliRenderer, ScrollBoxRenderable } from '@opentui/core';
import { onCleanup, onMount } from 'solid-js';
import type { OpenTuiKeymap } from '../platform/keymap/keymap-instance';
import type { TuiClipboardService } from '../platform/providers/clipboard-toast-context';
import type { TuiLocalPreferencesService } from '../platform/providers/local-preferences-context';
import type { TuiPromptStashService } from '../platform/providers/prompt-services-context';
import type { ChatTextareaHandle } from '../components/ChatInputTextarea';
import { applyHistoryRecallText } from '../components/prompt-history-recall';
import { registerPromptHistoryRecallLayers } from '../platform/keymap/prompt-history-recall';
import type { ChatStore } from '../state/chat-store';
import {
    parseModelPreferenceKeys,
    recentModelPreferenceSelections,
    selectionCopyEnabledForOverlay,
} from './app-helpers';

/**
 * Shared deps for all App keymap layer registrations.
 * Frozen for the simplify-tui-mount extract; single registration site per layer.
 */
export type KeymapLayersDeps = {
    readonly store: ChatStore;
    readonly keymap: OpenTuiKeymap;
    readonly renderer: CliRenderer;
    readonly clipboard: TuiClipboardService;
    readonly getViewportRows: () => number;
    readonly promptStash: TuiPromptStashService;
    readonly localPreferences: TuiLocalPreferencesService;
    readonly textareaHandle: ChatTextareaHandle;
    readonly scrollboxRef: {
        readonly current: ScrollBoxRenderable | null;
    };
    readonly promptMenuInteractionsEnabled: () => boolean;
    readonly handleSubmit: () => void;
};

function createMessagesScrollDeps(deps: KeymapLayersDeps) {
    const { store, renderer, clipboard, getViewportRows, scrollboxRef } = deps;
    return {
        scrollboxRef,
        clipboardService: clipboard,
        getViewportRows,
        getLastAssistantText: () => extractLastAssistantText(store.getSnapshot().outputText),
        getSelectionText: () => renderer.getSelection()?.getSelectedText() ?? '',
        clearSelection: () => renderer.clearSelection(),
    };
}

function navigateOpenMenu(store: ChatStore, textareaHandle: ChatTextareaHandle, direction: 'up' | 'down'): boolean {
    const text = textareaHandle.get()?.plainText ?? '';
    const snap = store.getSnapshot();
    if (text.startsWith('/')) {
        store.navigateSlashMenu(direction);
    } else if (text.startsWith('#')) {
        store.navigateWorkflowMenu(direction);
    } else if (text.startsWith('$')) {
        store.navigateSkillMenu(direction);
    } else if (snap.fileAutocomplete.open) {
        store.navigateFileAutocomplete(direction);
    }
    return true;
}

/** Registers every App keymap layer once; dynamic imports keep keymap FFI out of --no-tui. */
export function useKeymapLayers(deps: KeymapLayersDeps): void {
    const {
        store,
        keymap,
        renderer,
        promptStash,
        localPreferences,
        textareaHandle,
        promptMenuInteractionsEnabled,
        handleSubmit,
    } = deps;

    // Managed textarea + chat submit layer (T3): suspends native keyBindings so keys are not double-processed.
    onMount(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/keymap-managed-layer').then(
            ({ registerChatSubmitLayer, registerManagedTextareaComposition }) => {
                if (disposed) return;
                const offComposition = registerManagedTextareaComposition(keymap, renderer);
                const offSubmit = registerChatSubmitLayer(keymap, renderer, () => handleSubmit());
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

    // menu-navigation layer: priority 200 shadows managed textarea Up/Down while menus are open.
    onMount(() => {
        const offLayer = keymap.registerLayer({
            priority: 200,
            enabled: (): boolean => {
                if (!promptMenuInteractionsEnabled()) {
                    return false;
                }
                const text = textareaHandle.get()?.plainText ?? '';
                if (text.startsWith('/') || text.startsWith('#') || text.startsWith('$')) {
                    const token = text.slice(1);
                    return !token.includes(' ') && !token.includes('\n') && !token.includes('\t');
                }
                return store.getSnapshot().fileAutocomplete.open;
            },
            commands: [
                {
                    name: 'menu.up',
                    run: () => navigateOpenMenu(store, textareaHandle, 'up'),
                },
                {
                    name: 'menu.down',
                    run: () => navigateOpenMenu(store, textareaHandle, 'down'),
                },
            ],
            bindings: [
                { key: 'up', cmd: 'menu.up' },
                { key: 'down', cmd: 'menu.down' },
            ],
        });
        onCleanup(offLayer);
    });

    // Prompt history must run through the keymap because the managed textarea
    // consumes its own default Up/Down bindings before component callbacks.
    onMount(() => {
        const applyInlineHistorySelection = (): void => {
            const selected = store.selectedHistoryPickerText();
            if (selected === undefined) return;
            applyHistoryRecallText(textareaHandle.get(), selected, (text) => store.setInputMirror(text));
        };
        const offLayer = registerPromptHistoryRecallLayers(keymap, {
            isTextareaFocused: () => textareaHandle.get()?.focused === true,
            isCursorAtBufferStart: () => (textareaHandle.get()?.cursorOffset ?? -1) === 0,
            isHistoryOpen: () => store.getSnapshot().historyPicker.open,
            hasHistoryEntries: () => store.getSnapshot().historyEntries.length > 0,
            openPicker: () => {
                const currentInput = textareaHandle.get()?.plainText ?? store.getSnapshot().inputMirror;
                store.openHistoryPicker(currentInput);
                if (!promptMenuInteractionsEnabled()) {
                    applyInlineHistorySelection();
                }
            },
            navigatePicker: (direction) => {
                store.navigateHistoryPicker(direction);
                if (!promptMenuInteractionsEnabled()) {
                    applyInlineHistorySelection();
                }
            },
        });
        onCleanup(offLayer);
    });

    // messages.* scroll layer (T10): SESSION-scoped; OSC52 clipboard via renderer.
    onMount(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/messages-scroll').then(({ registerMessagesScrollLayer }) => {
            if (disposed) return;
            cleanup = registerMessagesScrollLayer(keymap, createMessagesScrollDeps(deps), {
                isEnabled: () => store.getSnapshot().overlayMode === 'none',
            });
        });
        onCleanup(() => {
            disposed = true;
            cleanup?.();
        });
    });

    // selection.copy layer: high-priority + selection-gated ctrl+d.
    onMount(() => {
        let disposed = false;
        let cleanup: (() => void) | undefined;
        void import('../platform/keymap/messages-scroll').then(({ registerSelectionCopyLayer }) => {
            if (disposed) return;
            cleanup = registerSelectionCopyLayer(keymap, createMessagesScrollDeps(deps), {
                isEnabled: () => selectionCopyEnabledForOverlay(store.getSnapshot().overlayMode),
            });
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
        void import('../platform/keymap/model-favorites').then(
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
        void import('../platform/keymap/session-shortcuts').then(({ registerSessionShortcutsLayer }) => {
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
        void import('../platform/keymap/message-undo-redo').then(({ registerMessageUndoRedoLayer }) => {
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
        void import('../platform/keymap/leader-addons').then(({ registerAbgMinimapToggleLayer }) => {
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
