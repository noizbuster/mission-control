import type { ModelProviderSelection } from '@mission-control/protocol';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import type { ChatOutput } from './interactive-chat-io.js';
import type { ActiveCodingAgentTurn } from './interactive-coding-agent.js';

export type RenameAction = { readonly kind: 'rename'; readonly name?: string };

/**
 * Read/update bridge for the in-memory session display name. The name lives in the
 * chat loop (not in `packages/core` session storage, which has no name field). The
 * `update` callback syncs the name into the bridge options so the StatusBar re-renders.
 */
export type SessionDisplayNameController = {
    readonly current: () => string | undefined;
    readonly update: (name: string) => void;
};

export async function runRenameAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    action: RenameAction,
    controller: SessionDisplayNameController | undefined,
    activeTurn: ActiveCodingAgentTurn | undefined,
): Promise<ChatActionResult> {
    if (action.name !== undefined) {
        controller?.update(action.name);
        chatOutput.write(`Session renamed to: ${action.name}\n`);
        return actionResult(modelProviderSelection, activeTurn);
    }
    const current = controller?.current();
    if (current !== undefined && current.length > 0) {
        chatOutput.write(`Session name: ${current}\n`);
    } else {
        chatOutput.write('Session is unnamed\n');
    }
    return actionResult(modelProviderSelection, activeTurn);
}
