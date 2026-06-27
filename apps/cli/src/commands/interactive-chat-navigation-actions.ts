import type { ModelProviderSelection } from '@mission-control/protocol';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result.js';
import type { CodingActionContext } from './interactive-chat-actions.js';
import type { ChatOutput } from './interactive-chat-io.js';
import type { SessionNavigationResult } from './interactive-chat-session-navigation.js';
import { isSessionNavigationError } from './interactive-chat-session-navigation-store.js';

export function runBranchContinueAction(
    chatOutput: ChatOutput,
    coding: CodingActionContext,
    modelProviderSelection: ModelProviderSelection,
    parentMessageId: string,
    prompt: string,
): ChatActionResult {
    emitPromptAdmission(chatOutput, coding, 'steer', prompt, parentMessageId);
    chatOutput.write(`Branch continue from ${parentMessageId}: ${prompt}\n`);
    return actionResult(modelProviderSelection, coding.activeTurn);
}

export async function runSessionNavigationAction(
    chatOutput: ChatOutput,
    coding: CodingActionContext,
    modelProviderSelection: ModelProviderSelection,
    action: () => Promise<SessionNavigationResult | undefined>,
    options?: { readonly requiresCurrentSession?: boolean },
): Promise<ChatActionResult> {
    if (coding.activeTurn !== undefined) {
        chatOutput.write('Interrupt the active run before switching sessions\n');
        return actionResult(modelProviderSelection, coding.activeTurn);
    }
    if (options?.requiresCurrentSession === true && coding.sessionId === undefined) {
        chatOutput.write('No active session yet — send a prompt first.\n');
        return actionResult(modelProviderSelection);
    }
    if (coding.sessionNavigation === undefined) {
        chatOutput.write('Session navigation is unavailable in this chat mode\n');
        return actionResult(modelProviderSelection);
    }
    try {
        const result = await action();
        if (result === undefined) {
            chatOutput.write('Session navigation is unavailable in this chat mode\n');
            return actionResult(modelProviderSelection);
        }
        chatOutput.write(result.message);
        return actionResult(result.modelProviderSelection ?? modelProviderSelection, undefined, {
            ...(result.sessionId !== undefined ? { sessionId: result.sessionId } : {}),
            ...(result.sessionStore !== undefined ? { sessionStore: result.sessionStore } : {}),
        });
    } catch (error) {
        if (!isSessionNavigationError(error)) {
            throw error;
        }
        chatOutput.write(`${error.message}\n`);
        return actionResult(modelProviderSelection);
    }
}

export function emitPromptAdmission(
    chatOutput: ChatOutput,
    coding: CodingActionContext,
    delivery: 'queue' | 'steer',
    prompt: string,
    parentMessageId?: string,
): void {
    const sessionId = coding.sessionId ?? 'interactive_session';
    const timestamp = new Date().toISOString();
    coding.emitEvent?.({
        type: 'prompt.admitted',
        timestamp,
        sessionId,
        message: prompt,
        transcript: {
            inputId: `${delivery}_${timestamp}`,
            messageId: `message_${timestamp}`,
            delivery,
            visibility: 'pending',
            ...(parentMessageId !== undefined ? { parentMessageId } : {}),
        },
    });
    if (parentMessageId === undefined) {
        chatOutput.write(`${delivery === 'queue' ? 'Queued follow-up' : 'Steering current run'}: ${prompt}\n`);
    }
}
