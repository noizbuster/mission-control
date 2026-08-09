import type { ModelProviderSelection } from '@mission-control/protocol';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result';
import type { ChatOutput } from './interactive-chat-io';
import {
    extractLastMessagePair,
    formatMessagePair,
    popUndonePair,
    pushUndonePair,
    type UndoRedoStack,
} from './interactive-chat-undo-redo-stack';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent';

export type UndoAction = { readonly kind: 'undo' };
export type RedoAction = { readonly kind: 'redo' };

/**
 * Bridge between the action handlers and the chat loop's in-memory
 * conversation state. The controller owns:
 *
 * - {@link readOutputText}: a snapshot of the conversation display text
 *   (kept in sync by the chat loop wrapping `chatOutput.write`).
 * - {@link replaceOutputText}: replaces that snapshot (used by `/undo`
 *   to remove the last pair). The production TUI handle supports replacing
 *   display text, while non-TUI output uses this local mirror; the
 *   display divergence is documented and the logical undo state stays
 *   correct.
 * - {@link getStack}/{@link setStack}: the LIFO undo/redo stack.
 *
 * **The durable session store is never touched by this controller
 * or the undo/redo actions.** All state is in-memory display only.
 */
export type UndoRedoConversationController = {
    readonly readOutputText: () => string;
    readonly replaceOutputText: (next: string) => void;
    /**
     * Optional typed-aware view undo/redo (TUI ChatStore). When present, /undo
     * and /redo prefer these so transcriptParts stay aligned with outputText.
     */
    readonly undoLastViewExchange?: () => 'ok' | 'generating' | 'empty' | 'already' | 'blocked';
    readonly redoLastViewExchange?: () => 'ok' | 'generating' | 'empty' | 'blocked';
    readonly getStack: () => UndoRedoStack;
    readonly setStack: (next: UndoRedoStack) => void;
};

export async function runUndoAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    controller: UndoRedoConversationController | undefined,
    activeTurn: ActiveCodingAgentTurn | undefined,
): Promise<ChatActionResult> {
    if (controller === undefined) {
        chatOutput.write('Undo unavailable: conversation tracking is not configured.\n');
        return actionResult(modelProviderSelection, activeTurn);
    }
    // Prefer the TUI store path so typed transcriptParts stay dual-consistent.
    if (controller.undoLastViewExchange !== undefined) {
        const result = controller.undoLastViewExchange();
        if (result === 'blocked') {
            chatOutput.write('Cannot undo while an overlay is open.\n');
            return actionResult(modelProviderSelection, activeTurn);
        }
        if (result === 'generating') {
            chatOutput.write('Cannot undo while generating.\n');
            return actionResult(modelProviderSelection, activeTurn);
        }
        if (result === 'already') {
            chatOutput.write('Nothing more to undo. Use /redo to restore.\n');
            return actionResult(modelProviderSelection, activeTurn);
        }
        if (result === 'empty') {
            chatOutput.write('Nothing to undo.\n');
            return actionResult(modelProviderSelection, activeTurn);
        }
        // conversationText mirror is updated inside undoLastViewExchange.
        chatOutput.write('Reverted last exchange. Use /redo to restore.\n');
        return actionResult(modelProviderSelection, activeTurn);
    }
    const currentText = controller.readOutputText();
    const extracted = extractLastMessagePair(currentText);
    if (extracted === undefined) {
        chatOutput.write('Nothing to undo.\n');
        return actionResult(modelProviderSelection, activeTurn);
    }
    const nextStack = pushUndonePair(controller.getStack(), extracted.pair);
    controller.replaceOutputText(extracted.remaining);
    controller.setStack(nextStack);
    chatOutput.write('Reverted last exchange. Use /redo to restore.\n');
    return actionResult(modelProviderSelection, activeTurn);
}

export async function runRedoAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    controller: UndoRedoConversationController | undefined,
    activeTurn: ActiveCodingAgentTurn | undefined,
): Promise<ChatActionResult> {
    if (controller === undefined) {
        chatOutput.write('Redo unavailable: conversation tracking is not configured.\n');
        return actionResult(modelProviderSelection, activeTurn);
    }
    if (controller.redoLastViewExchange !== undefined) {
        const result = controller.redoLastViewExchange();
        if (result === 'blocked') {
            chatOutput.write('Cannot redo while an overlay is open.\n');
            return actionResult(modelProviderSelection, activeTurn);
        }
        if (result === 'generating') {
            chatOutput.write('Cannot redo while generating.\n');
            return actionResult(modelProviderSelection, activeTurn);
        }
        if (result === 'empty') {
            chatOutput.write('Nothing to redo.\n');
            return actionResult(modelProviderSelection, activeTurn);
        }
        // conversationText mirror is updated inside redoLastViewExchange.
        chatOutput.write('Restored exchange.\n');
        return actionResult(modelProviderSelection, activeTurn);
    }
    const popped = popUndonePair(controller.getStack());
    if (popped.pair === undefined) {
        chatOutput.write('Nothing to redo.\n');
        return actionResult(modelProviderSelection, activeTurn);
    }
    controller.setStack(popped.stack);
    const currentText = controller.readOutputText();
    controller.replaceOutputText(currentText + formatMessagePair(popped.pair));
    chatOutput.write('Restored exchange.\n');
    return actionResult(modelProviderSelection, activeTurn);
}
