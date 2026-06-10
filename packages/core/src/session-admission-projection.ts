import type { AgentEvent } from '@mission-control/protocol';
import type {
    ModelVisibleTranscriptMessage,
    PromptDeliveryMode,
    PromptInputState,
    SessionAdmissionProjection,
    TranscriptBranchNode,
} from './session-admission-types.js';

export class SessionAdmissionProjectionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SessionAdmissionProjectionError';
    }
}

export function projectSessionAdmission(events: readonly AgentEvent[], sessionId: string): SessionAdmissionProjection {
    const admitted = new Map<string, PromptInputState>();
    const promotedIds = new Set<string>();
    const modelVisibleMessages: ModelVisibleTranscriptMessage[] = [];

    for (const event of events) {
        if (event.sessionId !== sessionId || event.transcript?.inputId === undefined) {
            continue;
        }
        if (event.type === 'prompt.admitted') {
            const input = promptInputFromEvent(event);
            admitted.set(input.inputId, input);
        }
        if (event.type === 'prompt.promoted') {
            promotedIds.add(event.transcript.inputId);
            const message = modelVisibleMessageFromEvent(event, admitted.get(event.transcript.inputId));
            if (message !== undefined) {
                modelVisibleMessages.push(message);
            }
        }
    }

    const pendingInputs = [...admitted.values()].filter((input) => !promotedIds.has(input.inputId));
    return {
        sessionId,
        admittedInputs: [...admitted.values()],
        pendingInputs,
        steeringInputs: pendingInputs.filter((input) => input.delivery === 'steer'),
        queuedInputs: pendingInputs.filter((input) => input.delivery === 'queue'),
        modelVisibleMessages,
        branchTree: projectTranscriptBranches(modelVisibleMessages),
    };
}

function promptInputFromEvent(event: AgentEvent): PromptInputState {
    const transcript = event.transcript;
    if (transcript?.inputId === undefined || transcript.messageId === undefined) {
        throw new SessionAdmissionProjectionError('prompt admission event is missing transcript ids');
    }
    return {
        inputId: transcript.inputId,
        messageId: transcript.messageId,
        prompt: event.message ?? '',
        delivery: parseDelivery(transcript.delivery),
        admittedAt: event.timestamp,
        ...(transcript.parentMessageId !== undefined ? { parentMessageId: transcript.parentMessageId } : {}),
        ...(transcript.providerTurnId !== undefined ? { providerTurnId: transcript.providerTurnId } : {}),
        ...(transcript.toolCallId !== undefined ? { toolCallId: transcript.toolCallId } : {}),
        ...(transcript.graphId !== undefined ? { graphId: transcript.graphId } : {}),
        ...(transcript.nodeId !== undefined ? { nodeId: transcript.nodeId } : {}),
    };
}

function modelVisibleMessageFromEvent(
    event: AgentEvent,
    admitted: PromptInputState | undefined,
): ModelVisibleTranscriptMessage | undefined {
    const transcript = event.transcript;
    if (transcript?.inputId === undefined || transcript.messageId === undefined) {
        return undefined;
    }
    return {
        inputId: transcript.inputId,
        messageId: transcript.messageId,
        role: 'user',
        content: event.message ?? admitted?.prompt ?? '',
        promotedAt: event.timestamp,
        delivery: parseDelivery(transcript.delivery ?? admitted?.delivery),
        ...(transcript.parentMessageId !== undefined ? { parentMessageId: transcript.parentMessageId } : {}),
        ...(transcript.providerTurnId !== undefined ? { providerTurnId: transcript.providerTurnId } : {}),
        ...(transcript.toolCallId !== undefined ? { toolCallId: transcript.toolCallId } : {}),
        ...(transcript.graphId !== undefined ? { graphId: transcript.graphId } : {}),
        ...(transcript.nodeId !== undefined ? { nodeId: transcript.nodeId } : {}),
    };
}

function projectTranscriptBranches(messages: readonly ModelVisibleTranscriptMessage[]): {
    readonly activeLeafMessageId?: string;
    readonly nodes: readonly TranscriptBranchNode[];
} {
    const nodes = new Map<
        string,
        { readonly messageId: string; readonly parentMessageId?: string; readonly childMessageIds: string[] }
    >();
    let previousMessageId: string | undefined;
    let activeLeafMessageId: string | undefined;

    for (const message of messages) {
        const parentMessageId = message.parentMessageId ?? previousMessageId;
        nodes.set(message.messageId, {
            messageId: message.messageId,
            ...(parentMessageId !== undefined ? { parentMessageId } : {}),
            childMessageIds: [],
        });
        if (parentMessageId !== undefined) {
            nodes.get(parentMessageId)?.childMessageIds.push(message.messageId);
        }
        previousMessageId = message.messageId;
        activeLeafMessageId = message.messageId;
    }

    return {
        ...(activeLeafMessageId !== undefined ? { activeLeafMessageId } : {}),
        nodes: [...nodes.values()].map((node) => ({
            messageId: node.messageId,
            ...(node.parentMessageId !== undefined ? { parentMessageId: node.parentMessageId } : {}),
            childMessageIds: [...node.childMessageIds],
        })),
    };
}

function parseDelivery(value: PromptDeliveryMode | undefined): PromptDeliveryMode {
    if (value === 'steer' || value === 'queue') {
        return value;
    }
    throw new SessionAdmissionProjectionError('prompt event is missing delivery mode');
}
