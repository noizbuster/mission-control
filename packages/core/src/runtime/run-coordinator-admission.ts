import type { AgentEvent, RunCoordinatorEventMetadata } from '@mission-control/protocol';
import type { AdmitPromptInput, PromptDeliveryMode, PromptInputState } from '../session-admission-types.js';

export type RunCoordinatorAdmissionProjection = {
    readonly pendingInputs: readonly PromptInputState[];
    readonly steeringInputs: readonly PromptInputState[];
    readonly queuedInputs: readonly PromptInputState[];
};

export function projectRunCoordinatorAdmission(
    events: readonly AgentEvent[],
    sessionId: string,
): RunCoordinatorAdmissionProjection {
    const admitted = new Map<string, PromptInputState>();
    const promotedIds = new Set<string>();

    for (const event of events) {
        if (event.sessionId !== sessionId) {
            continue;
        }
        const input = promptInputFromRunCommand(event) ?? promptInputFromAdmission(event);
        if (input !== undefined) {
            admitted.set(input.inputId, input);
        }
        if (event.type === 'prompt.promoted' && event.transcript?.inputId !== undefined) {
            promotedIds.add(event.transcript.inputId);
        }
    }

    const pendingInputs = [...admitted.values()].filter((input) => !promotedIds.has(input.inputId));
    return {
        pendingInputs,
        steeringInputs: pendingInputs.filter((input) => input.delivery === 'steer'),
        queuedInputs: pendingInputs.filter((input) => input.delivery === 'queue'),
    };
}

export function promptPromotionEvent(input: PromptInputState, sessionId: string, timestamp: string): AgentEvent {
    return {
        type: 'prompt.promoted',
        timestamp,
        sessionId,
        message: input.prompt,
        transcript: {
            inputId: input.inputId,
            messageId: input.messageId,
            delivery: input.delivery,
            visibility: 'model_visible',
            ...(input.parentMessageId !== undefined ? { parentMessageId: input.parentMessageId } : {}),
            ...(input.providerTurnId !== undefined ? { providerTurnId: input.providerTurnId } : {}),
            ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
            ...(input.graphId !== undefined ? { graphId: input.graphId } : {}),
            ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
        },
    };
}

export function runMetadataForPromptInput(input: Omit<AdmitPromptInput, 'resume'>): RunCoordinatorEventMetadata {
    return {
        inputId: input.inputId,
        messageId: input.messageId,
        delivery: input.delivery,
        ...(input.parentMessageId !== undefined ? { parentMessageId: input.parentMessageId } : {}),
        ...(input.providerTurnId !== undefined ? { providerTurnId: input.providerTurnId } : {}),
        ...(input.toolCallId !== undefined ? { toolCallId: input.toolCallId } : {}),
        ...(input.graphId !== undefined ? { graphId: input.graphId } : {}),
        ...(input.nodeId !== undefined ? { nodeId: input.nodeId } : {}),
    };
}

function promptInputFromRunCommand(event: AgentEvent): PromptInputState | undefined {
    if (event.run?.command !== 'steer' && event.run?.command !== 'queue') {
        return undefined;
    }
    if (event.run.inputId === undefined || event.run.messageId === undefined || event.message === undefined) {
        return undefined;
    }
    const delivery = parseDelivery(event.run.delivery ?? event.run.command);
    if (delivery === undefined) {
        return undefined;
    }
    return {
        inputId: event.run.inputId,
        messageId: event.run.messageId,
        prompt: event.message,
        delivery,
        admittedAt: event.timestamp,
        ...(event.run.parentMessageId !== undefined ? { parentMessageId: event.run.parentMessageId } : {}),
        ...(event.run.providerTurnId !== undefined ? { providerTurnId: event.run.providerTurnId } : {}),
        ...(event.run.toolCallId !== undefined ? { toolCallId: event.run.toolCallId } : {}),
        ...(event.run.graphId !== undefined ? { graphId: event.run.graphId } : {}),
        ...(event.run.nodeId !== undefined ? { nodeId: event.run.nodeId } : {}),
    };
}

function promptInputFromAdmission(event: AgentEvent): PromptInputState | undefined {
    const transcript = event.transcript;
    if (event.type !== 'prompt.admitted' || transcript?.inputId === undefined || transcript.messageId === undefined) {
        return undefined;
    }
    const delivery = parseDelivery(transcript.delivery);
    if (delivery === undefined) {
        return undefined;
    }
    return {
        inputId: transcript.inputId,
        messageId: transcript.messageId,
        prompt: event.message ?? '',
        delivery,
        admittedAt: event.timestamp,
        ...(transcript.parentMessageId !== undefined ? { parentMessageId: transcript.parentMessageId } : {}),
        ...(transcript.providerTurnId !== undefined ? { providerTurnId: transcript.providerTurnId } : {}),
        ...(transcript.toolCallId !== undefined ? { toolCallId: transcript.toolCallId } : {}),
        ...(transcript.graphId !== undefined ? { graphId: transcript.graphId } : {}),
        ...(transcript.nodeId !== undefined ? { nodeId: transcript.nodeId } : {}),
    };
}

function parseDelivery(value: PromptDeliveryMode | undefined): PromptDeliveryMode | undefined {
    return value === 'steer' || value === 'queue' ? value : undefined;
}
