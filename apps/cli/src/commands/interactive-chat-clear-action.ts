import type { ModelProviderSelection } from '@mission-control/protocol';
import type { ChatActionResult } from './interactive-chat-action-result.js';
import type { CodingActionContext } from './interactive-chat-actions.js';
import type { ChatOutput } from './interactive-chat-io.js';
import { runSessionNavigationAction } from './interactive-chat-navigation-actions.js';

export type ClearAction = { readonly kind: 'clear'; readonly sessionId?: string };

/**
 * `/clear` creates a new durable session (reusing the same `/new` session
 * navigation logic) AND clears the TUI display. The durable JSONL log of the
 * OLD session is NOT deleted — only the in-memory display (conversation mirror
 * + bridge output text) is cleared via the undo/redo controller's
 * {@link UndoRedoConversationController.replaceOutputText} seam, which is
 * already wired to call `tuiBridge?.replaceOutputText(next)` in the chat loop.
 */
export async function runClearAction(
    chatOutput: ChatOutput,
    coding: CodingActionContext,
    modelProviderSelection: ModelProviderSelection,
    action: ClearAction,
): Promise<ChatActionResult> {
    const result = await runSessionNavigationAction(chatOutput, coding, modelProviderSelection, () =>
        coding.sessionNavigation === undefined
            ? Promise.resolve(undefined)
            : coding.sessionNavigation.startNewSession({
                  modelProviderSelection,
                  ...(action.sessionId !== undefined ? { sessionId: action.sessionId } : {}),
              }),
    );
    // Only clear the display when a new session was actually created.
    // If navigation was unavailable or blocked by an active turn, the
    // runSessionNavigationAction message is already visible to the user.
    if (result.sessionId === undefined) {
        return result;
    }
    coding.undoRedo?.replaceOutputText('');
    chatOutput.write(`Screen cleared. New session: ${result.sessionId}\n`);
    return result;
}
