import type { ModelProviderSelection } from '@mission-control/protocol';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import type { CodingActionContext } from './interactive-chat-actions.js';
import type { ChatOutput } from './interactive-chat-io.js';
import { exportSessionArchiveFile } from './session-archive.js';

export type ExportAction = { readonly kind: 'export'; readonly path: string };

export async function runExportAction(
    chatOutput: ChatOutput,
    modelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
    action: ExportAction,
): Promise<ChatActionResult> {
    if (coding.sessionId === undefined) {
        chatOutput.write('Error: export requires an active session\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    try {
        const message = await exportSessionArchiveFile({
            sessionId: coding.sessionId,
            filePath: action.path,
        });
        chatOutput.write(message);
    } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error);
        chatOutput.write(`Error: ${detail}\n`);
    }
    return actionResult(modelProviderSelection, coding.activeTurn);
}
