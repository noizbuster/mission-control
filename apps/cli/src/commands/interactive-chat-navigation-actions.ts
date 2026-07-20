import type { AgentEvent, ModelProviderSelection } from '@mission-control/protocol';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result';
import type { CodingActionContext } from './interactive-chat-actions';
import type { ChatOutput } from './interactive-chat-io';
import type { SessionNavigationResult } from './interactive-chat-session-navigation';
import { isSessionNavigationError } from './interactive-chat-session-navigation-store';
import {
    applySessionAttachProjection,
    projectSessionAttachFromEvents,
} from './session-attach-projection';
import { loadSessionTranscript } from './session-transcript-reconstruction';

export function runBranchContinueAction(
    chatOutput: ChatOutput,
    coding: CodingActionContext,
    modelProviderSelection: ModelProviderSelection,
    parentMessageId: string,
    prompt: string,
): ChatActionResult {
    if (coding.activeTurn === undefined) {
        chatOutput.write('No active run to branch-continue into — start a prompt first.\n');
        return actionResult(modelProviderSelection);
    }
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
        if (result.sessionId !== undefined) {
            const transcript = await loadSessionTranscript(result.sessionId, coding.observabilityRedactor);
            coding.undoRedo?.replaceOutputText(transcript);
            const events = await loadAttachEvents(result.sessionId, result.sessionStore ?? coding.sessionStore);
            applySessionAttachProjection({
                events,
                projection: projectSessionAttachFromEvents(events),
                abgOverlayController: coding.abgOverlayController,
                chatOutput,
            });
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

async function loadAttachEvents(
    sessionId: string,
    sessionStore: CodingActionContext['sessionStore'],
): Promise<readonly AgentEvent[]> {
    if (sessionStore === undefined) return [];
    return sessionStore.getEvents(sessionId);
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
