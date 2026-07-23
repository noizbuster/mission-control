import type { ModelProviderSelection } from '@mission-control/protocol';
import { actionResult, type ChatActionResult } from './interactive-chat-action-result';
import type { CodingActionContext } from './interactive-chat-actions';
import type { ChatOutput } from './interactive-chat-io';
import type { SessionNavigationResult } from './interactive-chat-session-navigation';
import { isSessionNavigationError } from './interactive-chat-session-navigation-store';
import { applySessionAttachProjection, projectSessionAttachFromEvents } from './session-attach-projection';
import {
    loadSessionTranscriptParts,
    loadSessionTranscriptPartsAndEventsFromStore,
} from './session-transcript-reconstruction';

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
            const attachedStore = result.sessionStore ?? coding.sessionStore;
            const attached =
                attachedStore === undefined
                    ? undefined
                    : await loadSessionTranscriptPartsAndEventsFromStore(
                          attachedStore,
                          result.sessionId,
                          coding.observabilityRedactor,
                      );
            const transcript =
                attached ?? (await loadSessionTranscriptParts(result.sessionId, coding.observabilityRedactor));
            if (coding.replaceSessionTranscript !== undefined) {
                coding.replaceSessionTranscript(transcript.parts, transcript.outputText);
            } else {
                if (!coding.useTui && transcript.outputText.length > 0) {
                    chatOutput.write(transcript.outputText);
                }
                coding.undoRedo?.replaceOutputText(transcript.outputText);
            }
            const events = attached?.events ?? [];
            applySessionAttachProjection({
                events,
                projection: projectSessionAttachFromEvents(events),
                abgOverlayController: coding.abgOverlayController,
                chatOutput,
                ...(coding.onUsage !== undefined ? { onUsage: coding.onUsage } : {}),
                ...(coding.onSessionCacheUsage !== undefined
                    ? { onContextCacheUsage: coding.onSessionCacheUsage }
                    : {}),
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
