import { describe, expect, it } from 'vitest';
import { createChatStore } from '../../state/chat-store';
import {
    PROMPT_HISTORY_RECALL_PRIORITY,
    registerPromptHistoryRecallLayers,
    type PromptHistoryRecallLayer,
    type PromptHistoryRecallLayerRegistrar,
} from './prompt-history-recall';

describe('registerPromptHistoryRecallLayers', () => {
    it('shadows managed textarea arrows only for eligible prompt-history recall', () => {
        const layers: PromptHistoryRecallLayer[] = [];
        let disposed = 0;
        let focused = false;
        let cursorAtBufferStart = false;
        let historyOpen = false;
        let hasHistoryEntries = false;
        let opened = 0;
        const navigated: ('up' | 'down')[] = [];
        const keymap: PromptHistoryRecallLayerRegistrar = {
            registerLayer(layer): () => void {
                layers.push(layer);
                return () => {
                    disposed += 1;
                };
            },
        };

        const cleanup = registerPromptHistoryRecallLayers(keymap, {
            isTextareaFocused: () => focused,
            isCursorAtBufferStart: () => cursorAtBufferStart,
            isHistoryOpen: () => historyOpen,
            hasHistoryEntries: () => hasHistoryEntries,
            openPicker: () => {
                opened += 1;
            },
            navigatePicker: (direction) => {
                navigated.push(direction);
            },
        });
        const navigationLayer = layers.find((layer) => layer.bindings.some((binding) => binding.key === 'down'));
        const startLayer = layers.find((layer) => layer.bindings.length === 1 && layer.bindings[0]?.key === 'up');
        if (navigationLayer === undefined || startLayer === undefined) {
            throw new Error('Prompt history layers were not registered');
        }

        expect(navigationLayer.priority).toBe(PROMPT_HISTORY_RECALL_PRIORITY);
        expect(startLayer.priority).toBe(PROMPT_HISTORY_RECALL_PRIORITY);
        expect(navigationLayer.enabled()).toBe(false);
        expect(startLayer.enabled()).toBe(false);

        focused = true;
        hasHistoryEntries = true;
        expect(startLayer.enabled()).toBe(false);
        cursorAtBufferStart = true;
        expect(startLayer.enabled()).toBe(true);
        expect(navigationLayer.enabled()).toBe(false);

        const open = startLayer.commands.find((command) => command.name === 'prompt.history.open');
        if (open === undefined) {
            throw new Error('Open prompt-history command was not registered');
        }
        expect(open.run()).toBe(true);
        expect(opened).toBe(1);

        historyOpen = true;
        expect(startLayer.enabled()).toBe(false);
        expect(navigationLayer.enabled()).toBe(true);
        const previous = navigationLayer.commands.find((command) => command.name === 'prompt.history.previous');
        const next = navigationLayer.commands.find((command) => command.name === 'prompt.history.next');
        if (previous === undefined || next === undefined) {
            throw new Error('Prompt-history navigation commands were not registered');
        }
        expect(previous.run()).toBe(true);
        expect(next.run()).toBe(true);
        expect(navigated).toEqual(['up', 'down']);

        hasHistoryEntries = false;
        expect(navigationLayer.enabled()).toBe(false);
        cleanup();
        expect(disposed).toBe(2);
    });
});

describe('prompt history keymap selection', () => {
    it('opens the picker and moves its selected row with Up and Down', () => {
        const store = createChatStore({
            initialHistoryEntries: [
                { id: 'older', text: 'older prompt', timestamp: 1 },
                { id: 'newer', text: 'newer prompt', timestamp: 2 },
            ],
        });
        const layers: PromptHistoryRecallLayer[] = [];
        const keymap: PromptHistoryRecallLayerRegistrar = {
            registerLayer(layer): () => void {
                layers.push(layer);
                return () => {};
            },
        };
        const cleanup = registerPromptHistoryRecallLayers(keymap, {
            isTextareaFocused: () => true,
            isCursorAtBufferStart: () => true,
            isHistoryOpen: () => store.isHistoryPickerOpen(),
            hasHistoryEntries: () => store.getSnapshot().historyEntries.length > 0,
            openPicker: () => {
                store.openHistoryPicker('draft');
            },
            navigatePicker: (direction) => {
                store.navigateHistoryPicker(direction);
            },
        });
        const navigationLayer = layers.find((layer) => layer.bindings.some((binding) => binding.key === 'down'));
        const startLayer = layers.find((layer) => layer.bindings.length === 1 && layer.bindings[0]?.key === 'up');
        if (navigationLayer === undefined || startLayer === undefined) {
            throw new Error('Prompt history layers were not registered');
        }
        const open = startLayer.commands.find((command) => command.name === 'prompt.history.open');
        const previous = navigationLayer.commands.find((command) => command.name === 'prompt.history.previous');
        const next = navigationLayer.commands.find((command) => command.name === 'prompt.history.next');
        if (open === undefined || previous === undefined || next === undefined) {
            throw new Error('Prompt history commands were not registered');
        }

        expect(open.run()).toBe(true);
        expect(store.getSnapshot().historyPicker.selectedIndex).toBe(0);
        expect(previous.run()).toBe(true);
        expect(store.getSnapshot().historyPicker.selectedIndex).toBe(1);
        expect(next.run()).toBe(true);
        expect(store.getSnapshot().historyPicker.selectedIndex).toBe(0);
        cleanup();
    });
});
