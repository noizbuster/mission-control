import type { HistoryPickerDirection } from '../../state/history-picker-state';

export const PROMPT_HISTORY_RECALL_PRIORITY = 150;

export type PromptHistoryRecallCommand = {
    readonly name: 'prompt.history.previous' | 'prompt.history.next';
    readonly run: () => boolean;
};

export type PromptHistoryRecallBinding = {
    readonly key: 'up' | 'down';
    readonly cmd: PromptHistoryRecallCommand['name'];
};

export type PromptHistoryRecallLayer = {
    readonly priority: number;
    readonly enabled: () => boolean;
    readonly commands: readonly PromptHistoryRecallCommand[];
    readonly bindings: readonly PromptHistoryRecallBinding[];
};

export type PromptHistoryRecallLayerRegistrar = {
    readonly registerLayer: (layer: PromptHistoryRecallLayer) => () => void;
};

export type PromptHistoryRecallLayerDeps = {
    readonly isTextareaFocused: () => boolean;
    readonly isCursorAtBufferStart: () => boolean;
    readonly isHistoryOpen: () => boolean;
    readonly hasHistoryEntries: () => boolean;
    readonly recall: (direction: HistoryPickerDirection) => void;
};

/**
 * Route prompt-history arrows through the keymap before the managed textarea
 * consumes its default Up/Down cursor bindings. Menu navigation at priority
 * 200 remains authoritative over this priority-150 layer.
 */
export function registerPromptHistoryRecallLayers(
    keymap: PromptHistoryRecallLayerRegistrar,
    deps: PromptHistoryRecallLayerDeps,
): () => void {
    const previous: PromptHistoryRecallCommand = {
        name: 'prompt.history.previous',
        run: () => {
            deps.recall('up');
            return true;
        },
    };
    const next: PromptHistoryRecallCommand = {
        name: 'prompt.history.next',
        run: () => {
            deps.recall('down');
            return true;
        },
    };
    const offNavigation = keymap.registerLayer({
        priority: PROMPT_HISTORY_RECALL_PRIORITY,
        enabled: () => deps.isTextareaFocused() && deps.isHistoryOpen() && deps.hasHistoryEntries(),
        commands: [previous, next],
        bindings: [
            { key: 'up', cmd: previous.name },
            { key: 'down', cmd: next.name },
        ],
    });
    const offStart = keymap.registerLayer({
        priority: PROMPT_HISTORY_RECALL_PRIORITY,
        enabled: () =>
            deps.isTextareaFocused() &&
            deps.isCursorAtBufferStart() &&
            !deps.isHistoryOpen() &&
            deps.hasHistoryEntries(),
        commands: [previous],
        bindings: [{ key: 'up', cmd: previous.name }],
    });

    return () => {
        offStart();
        offNavigation();
    };
}
