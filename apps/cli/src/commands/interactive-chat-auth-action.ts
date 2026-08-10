import type { ModelProviderSelection } from '@mission-control/protocol';
import { runAuthCommand } from './auth';
import type { AuthCommand } from './auth-command';
import type { CodingActionContext } from './interactive-chat-action-context';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result';
import type { ChatOutput } from './interactive-chat-io';

/**
 * Run a parsed `/auth` slash command by delegating to {@linkcode runAuthCommand}.
 *
 * Reuses the shared auth store from coding context when present so interactive
 * chat stays consistent with the rest of the session credential surface.
 */
export async function runAuthChatAction(
    chatOutput: ChatOutput,
    selection: ModelProviderSelection,
    coding: CodingActionContext,
    command: AuthCommand,
): Promise<ChatActionResult> {
    if (command.kind === 'invalid') {
        chatOutput.write(`${command.message}\n`);
        return actionResult(selection, coding.activeTurn);
    }
    try {
        const output = await runAuthCommand(command.args, {
            ...(coding.authStore !== undefined ? { store: coding.authStore } : {}),
        });
        chatOutput.write(ensureTrailingNewline(output));
    } catch (error: unknown) {
        chatOutput.write(`Auth command failed: ${errorMessage(error)}\n`);
    }
    return actionResult(selection, coding.activeTurn);
}

function ensureTrailingNewline(text: string): string {
    return text.endsWith('\n') ? text : `${text}\n`;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
