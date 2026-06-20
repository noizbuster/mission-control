import type { AgentRuntime } from '@mission-control/core';
import type { ModelProviderSelection } from '@mission-control/protocol';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import type { CodingActionContext } from './interactive-chat-actions.js';
import { startCompactionTurn } from './interactive-chat-compact.js';
import type { ChatOutput } from './interactive-chat-io.js';

export function runCompactAction(
    _runtime: AgentRuntime,
    chatOutput: ChatOutput,
    currentModelProviderSelection: ModelProviderSelection,
    coding: CodingActionContext,
    instructions?: string,
): ChatActionResult {
    if (coding.activeTurn !== undefined) {
        chatOutput.write('Interrupt the active run before compacting the session\n');
        return actionResult(currentModelProviderSelection, coding.activeTurn);
    }
    if (coding.provider === undefined || coding.sessionId === undefined || coding.sessionStore === undefined) {
        chatOutput.write('Compact command unavailable: no durable session is active\n');
        return actionResult(currentModelProviderSelection);
    }
    return actionResult(
        currentModelProviderSelection,
        startCompactionTurn({
            sessionId: coding.sessionId,
            store: coding.sessionStore,
            provider: coding.provider,
            modelProviderSelection: currentModelProviderSelection,
            output: chatOutput,
            ...(coding.workspaceRoot !== undefined ? { workspaceRoot: coding.workspaceRoot } : {}),
            ...(coding.observeStoredEvent !== undefined ? { observeStoredEvent: coding.observeStoredEvent } : {}),
            ...(instructions !== undefined ? { instructions } : {}),
        }),
    );
}
