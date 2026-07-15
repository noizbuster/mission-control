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
