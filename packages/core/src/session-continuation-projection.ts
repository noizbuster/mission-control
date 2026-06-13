import {
    type AgentEvent,
    type AgentMessage,
    AgentMessageSchema,
    type ProviderToolCallTranscript,
} from '@mission-control/protocol';

export type SequencedAgentMessage = {
    readonly message: AgentMessage;
    readonly sourceSequence: number;
};

export function projectApprovalContinuationMessages(
    events: readonly AgentEvent[],
    sessionId: string,
): readonly AgentMessage[] {
    return applyLatestCompaction(
        projectApprovalContinuationTranscript(events, sessionId),
        latestCompaction(events, sessionId),
    ).map((entry) => entry.message);
}

export function projectApprovalContinuationTranscript(
    events: readonly AgentEvent[],
    sessionId: string,
): readonly SequencedAgentMessage[] {
    const messages: SequencedAgentMessage[] = [];
    let currentToolCalls: ProviderToolCallTranscript[] = [];

    events.forEach((event, sourceSequence) => {
        if (event.sessionId !== sessionId) {
            return;
        }
        if (event.type === 'model.call.started') {
            currentToolCalls = [];
        }
        appendPromptMessage(messages, event, sourceSequence);
        collectProviderToolCall(currentToolCalls, event);
        appendAssistantMessage(messages, event, currentToolCalls, sourceSequence);
        appendToolResultMessage(messages, event, sourceSequence);
    });
    return messages;
}

export function hasPendingDesktopApprovals(events: readonly AgentEvent[], sessionId: string): boolean {
    const approvalStates = new Map<string, string>();
    for (const event of events) {
        if (event.sessionId !== sessionId || event.approvalRecord === undefined) {
            continue;
        }
        approvalStates.set(event.approvalRecord.approvalId, event.approvalRecord.state);
    }
    return [...approvalStates.values()].some((state) => state === 'pending');
}

function appendPromptMessage(messages: SequencedAgentMessage[], event: AgentEvent, sourceSequence: number): void {
    if (event.type !== 'prompt.promoted') {
        return;
    }
    messages.push({
        message: AgentMessageSchema.parse({
            role: 'user',
            content: event.message ?? '',
        }),
        sourceSequence,
    });
}

function collectProviderToolCall(toolCalls: ProviderToolCallTranscript[], event: AgentEvent): void {
    const chunk = event.providerStreamChunk;
    if (chunk?.kind !== 'tool_call_completed') {
        return;
    }
    toolCalls.push({
        providerID: event.modelProviderSelection?.providerID ?? 'unknown',
        toolCallId: chunk.toolCall.toolCallId,
        toolName: chunk.toolCall.toolName,
        argumentsJson: chunk.toolCall.argumentsJson,
    });
}

function appendAssistantMessage(
    messages: SequencedAgentMessage[],
    event: AgentEvent,
    currentToolCalls: readonly ProviderToolCallTranscript[],
    sourceSequence: number,
): void {
    const chunk = event.providerStreamChunk;
    if (chunk?.kind !== 'response_completed') {
        return;
    }
    const providerToolCalls = chunk.message.providerToolCalls ?? currentToolCalls;
    messages.push({
        message: AgentMessageSchema.parse({
            role: 'assistant',
            content: chunk.message.content,
            ...(providerToolCalls.length > 0 ? { providerToolCalls: [...providerToolCalls] } : {}),
        }),
        sourceSequence,
    });
}

function appendToolResultMessage(messages: SequencedAgentMessage[], event: AgentEvent, sourceSequence: number): void {
    if (event.toolResult === undefined) {
        return;
    }
    messages.push({
        message: AgentMessageSchema.parse({
            role: 'tool',
            toolCallId: event.toolResult.toolCallId,
            status: event.toolResult.status,
            ...(event.toolResult.output !== undefined ? { output: event.toolResult.output } : {}),
            ...(event.toolResult.error !== undefined ? { error: event.toolResult.error } : {}),
            ...(event.toolResult.redactions !== undefined ? { redactions: event.toolResult.redactions } : {}),
        }),
        sourceSequence,
    });
}

type LatestCompaction = {
    readonly boundarySequence: number;
    readonly compactionSequence: number;
    readonly firstKeptSequence: number;
    readonly summary: string;
};

function latestCompaction(events: readonly AgentEvent[], sessionId: string): LatestCompaction | undefined {
    let latest: LatestCompaction | undefined;
    events.forEach((event, compactionSequence) => {
        if (event.sessionId !== sessionId || !isCompleteCompactionBoundary(event.sessionTree)) {
            return;
        }
        latest = {
            boundarySequence: event.sessionTree.boundarySequence,
            compactionSequence,
            firstKeptSequence: event.sessionTree.firstKeptSequence,
            summary: event.sessionTree.summary,
        };
    });
    return latest;
}

function applyLatestCompaction(
    transcript: readonly SequencedAgentMessage[],
    compaction: LatestCompaction | undefined,
): readonly SequencedAgentMessage[] {
    if (compaction === undefined) {
        return transcript;
    }
    const retained = transcript.filter(
        (entry) =>
            (entry.sourceSequence >= compaction.firstKeptSequence &&
                entry.sourceSequence <= compaction.boundarySequence) ||
            entry.sourceSequence > compaction.compactionSequence,
    );
    return [
        {
            message: AgentMessageSchema.parse({
                role: 'user',
                content: `Session memory summary (untrusted, model-generated):\n${compaction.summary}`,
            }),
            sourceSequence: compaction.compactionSequence,
        },
        ...retained,
    ];
}

function isCompleteCompactionBoundary(value: unknown): value is {
    readonly kind: 'compaction';
    readonly summary: string;
    readonly boundarySequence: number;
    readonly firstKeptSequence: number;
} {
    return (
        isRecord(value) &&
        value.kind === 'compaction' &&
        typeof value.summary === 'string' &&
        typeof value.boundarySequence === 'number' &&
        typeof value.firstKeptSequence === 'number'
    );
}

type CompactionBoundaryCandidate = {
    readonly kind?: unknown;
    readonly summary?: unknown;
    readonly boundarySequence?: unknown;
    readonly firstKeptSequence?: unknown;
};

function isRecord(value: unknown): value is CompactionBoundaryCandidate {
    return typeof value === 'object' && value !== null;
}
