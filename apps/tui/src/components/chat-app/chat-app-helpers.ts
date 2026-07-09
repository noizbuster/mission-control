import type { ModelProviderSelection } from '@mission-control/protocol';
import type { ChatBlock } from '@mission-control/tui/chat';
import { parseModelSelection } from '../../state/interactive-chat-model.js';

/**
 * Reuse previous block references when content (kind + element-wise lines) is unchanged.
 * Precondition for memoized MessageBlock rendering: without reference stability, memo never skips.
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

export type PromptPanelRepaintKeyInput = {
    readonly inputMirror: string;
    readonly fileAutocompleteOpen: boolean;
    readonly fileMatchCount: number;
    readonly menuRows: number;
};

export function promptPanelRepaintKey(input: PromptPanelRepaintKeyInput): string {
    if (input.menuRows <= 0) return 'none';
    if (input.inputMirror.startsWith('/')) return `slash:${input.inputMirror}`;
    if (input.inputMirror.startsWith('#')) return `workflow:${input.inputMirror}`;
    if (input.fileAutocompleteOpen) return `file:${input.inputMirror}:${input.fileMatchCount}`;
    return 'none';
}

export function parseModelPreferenceKeys(keys: readonly string[]): readonly ModelProviderSelection[] {
    return keys.flatMap((key) => {
        const selection = parseModelSelection(key);
        return selection === undefined ? [] : [selection];
    });
}

export function recentModelPreferenceSelections(keys: readonly string[]): readonly ModelProviderSelection[] {
    return [...parseModelPreferenceKeys(keys)].reverse();
}
