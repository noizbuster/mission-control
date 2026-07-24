import { describe, expect, it } from 'vitest';
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
        const recalled: ('up' | 'down')[] = [];
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
            recall: (direction) => {
                recalled.push(direction);
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

        const previous = startLayer.commands.find((command) => command.name === 'prompt.history.previous');
        if (previous === undefined) {
            throw new Error('Previous prompt command was not registered');
        }
        expect(previous.run()).toBe(true);
        expect(recalled).toEqual(['up']);

        historyOpen = true;
        expect(startLayer.enabled()).toBe(false);
        expect(navigationLayer.enabled()).toBe(true);
        const next = navigationLayer.commands.find((command) => command.name === 'prompt.history.next');
        if (next === undefined) {
            throw new Error('Next prompt command was not registered');
        }
        expect(next.run()).toBe(true);
        expect(recalled).toEqual(['up', 'down']);

        hasHistoryEntries = false;
        expect(navigationLayer.enabled()).toBe(false);
        cleanup();
        expect(disposed).toBe(2);
    });
});
