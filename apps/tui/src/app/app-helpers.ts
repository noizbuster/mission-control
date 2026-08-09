import type { ModelProviderSelection } from '@mission-control/protocol';
import type { ChatBlock } from '@mission-control/tui/chat';
import type { TuiRuntimeProviderValue } from '../platform/providers/runtime-context';
import { parseModelSelection } from '../state/interactive-chat-model';
import type { ChatStoreOverlayMode, ChatStoreState } from '../state/chat-store';
import type { StatusBarProps } from '../components/StatusBar';

/**
 * Reuse previous block references when content (kind + element-wise lines) is unchanged.
 * Precondition for memoized MessageBlock rendering: without reference stability, memo never skips.
 *
 * Returns the previous array reference when length and every element are identical, so the
 * surrounding `createMemo` is referentially stable across unrelated ChatStore publishes (typing,
 * stream coalesce ticks, etc). This stops downstream `<Index each={blocks}>` from reconciling
 * and prevents the OpenTUI scrollbox from re-measuring scrollHeight on every keystroke, which
 * surfaced as a 1-row screen shift / scrollbar flicker whenever the transcript had content.
 */
export function preserveBlockReferences(fresh: readonly ChatBlock[], prev: readonly ChatBlock[]): readonly ChatBlock[] {
    if (fresh.length === prev.length) {
        let unchanged = true;
        for (let i = 0; i < fresh.length; i += 1) {
            const block = fresh[i];
            const old = prev[i];
            if (block === undefined || old === undefined) {
                unchanged = false;
                break;
            }
            if (
                block.kind !== old.kind ||
                block.lines.length !== old.lines.length ||
                !block.lines.every((line, j) => line === old.lines[j])
            ) {
                unchanged = false;
                break;
            }
        }
        if (unchanged) return prev;
    }
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

/**
 * Ctrl+D copies terminal selections in the transcript and the ABG overlay.
 * Other overlays reserve keyboard input for their own controls.
 */
export function selectionCopyEnabledForOverlay(overlayMode: ChatStoreOverlayMode): boolean {
    switch (overlayMode) {
        case 'none':
        case 'abg':
            return true;
        default:
            return false;
    }
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

export function deriveStatusBarProps(runtime: TuiRuntimeProviderValue, snap: ChatStoreState): StatusBarProps {
    const selection = snap.currentModelSelection;
    const providerID = selection?.providerID ?? runtime.providerID;
    const modelID = selection?.modelID ?? runtime.modelID;
    const variantID = selection?.variantID ?? snap.currentModelVariantID ?? runtime.variantID;
    const sessionID = snap.sessionId.length > 0 ? snap.sessionId : runtime.sessionID;
    const cache = snap.contextCacheUsage;
    return {
        providerID,
        modelID,
        ...(variantID !== undefined ? { variantID } : {}),
        ...(sessionID !== undefined && sessionID.length > 0 ? { sessionID } : {}),
        ...(runtime.workspaceRoot !== undefined ? { workspaceRoot: runtime.workspaceRoot } : {}),
        ...(runtime.gitBranch !== undefined ? { gitBranch: runtime.gitBranch } : {}),
        ...(runtime.isWorktree ? { isWorktree: true } : {}),
        ...(snap.contextTokensUsed !== undefined ? { contextTokensUsed: snap.contextTokensUsed } : {}),
        ...(snap.contextTokensMax !== undefined ? { contextTokensMax: snap.contextTokensMax } : {}),
        ...(cache !== undefined
            ? {
                  contextCacheInputTokens: cache.inputTokens,
                  contextCacheReadTokens: cache.cacheReadTokens,
              }
            : {}),
        ...(snap.approvalLevel !== undefined ? { approvalLevel: snap.approvalLevel } : {}),
    };
}
