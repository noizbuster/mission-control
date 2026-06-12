import {
    type AgentEvent,
    type AgentMessage,
    AgentMessageSchema,
    type ProviderToolCallTranscript,
} from '@mission-control/protocol';

export function projectDesktopApprovalContinuationMessages(
    events: readonly AgentEvent[],
    sessionId: string,
): readonly AgentMessage[] {
    const messages: AgentMessage[] = [];
    let currentToolCalls: ProviderToolCallTranscript[] = [];

    for (const event of events) {
        if (event.sessionId !== sessionId) {
            continue;
        }
        if (event.type === 'model.call.started') {
            currentToolCalls = [];
        }
        appendPromptMessage(messages, event);
        collectProviderToolCall(currentToolCalls, event);
        appendAssistantMessage(messages, event, currentToolCalls);
        appendToolResultMessage(messages, event);
    }
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

function appendPromptMessage(messages: AgentMessage[], event: AgentEvent): void {
    if (event.type !== 'prompt.promoted') {
        return;
    }
    messages.push(
        AgentMessageSchema.parse({
            role: 'user',
            content: event.message ?? '',
        }),
    );
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
    messages: AgentMessage[],
    event: AgentEvent,
    currentToolCalls: readonly ProviderToolCallTranscript[],
): void {
    const chunk = event.providerStreamChunk;
    if (chunk?.kind !== 'response_completed') {
        return;
    }
    const providerToolCalls = chunk.message.providerToolCalls ?? currentToolCalls;
    messages.push(
        AgentMessageSchema.parse({
            role: 'assistant',
            content: chunk.message.content,
            ...(providerToolCalls.length > 0 ? { providerToolCalls: [...providerToolCalls] } : {}),
        }),
    );
}

function appendToolResultMessage(messages: AgentMessage[], event: AgentEvent): void {
    if (event.toolResult === undefined) {
        return;
    }
    messages.push(
        AgentMessageSchema.parse({
            role: 'tool',
            toolCallId: event.toolResult.toolCallId,
            status: event.toolResult.status,
            ...(event.toolResult.output !== undefined ? { output: event.toolResult.output } : {}),
            ...(event.toolResult.error !== undefined ? { error: event.toolResult.error } : {}),
            ...(event.toolResult.redactions !== undefined ? { redactions: event.toolResult.redactions } : {}),
        }),
    );
}
