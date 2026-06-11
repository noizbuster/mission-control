import {
    type AgentEvent,
    type AgentEventEnvelope,
    type AgentMessage,
    AgentMessageSchema,
    type ModelProviderSelection,
    type ProtocolError,
    type ProviderMessage,
    type ToolCall,
    ToolResultSchema,
} from '@mission-control/protocol';
import type { ToolInvocationSettlement, ToolRegistry } from './tools/tool-registry.js';

export const DEFAULT_PROVIDER_TOOL_CONTINUATION_LIMIT = 8;

export type AppendProviderToolResultMessagesInput = {
    readonly messages: readonly AgentMessage[];
    readonly assistantMessage: ProviderMessage;
    readonly settlements: readonly ToolInvocationSettlement[];
};

export function toolCallsFromProviderEnvelopes(envelopes: readonly AgentEventEnvelope[]): readonly ToolCall[] {
    return envelopes.flatMap((envelope) => {
        const chunk = envelope.event.providerStreamChunk;
        return chunk?.kind === 'tool_call_completed' ? [chunk.toolCall] : [];
    });
}

export function appendProviderToolResultMessages(
    input: AppendProviderToolResultMessagesInput,
): readonly AgentMessage[] {
    return [
        ...input.messages,
        providerMessageToAgentMessage(input.assistantMessage),
        ...input.settlements.map((settlement) => toolResultToAgentMessage(settlement.result)),
    ];
}

export async function settleToolCallWithRegistry(
    registry: ToolRegistry,
    toolCall: ToolCall,
    signal: AbortSignal,
): Promise<ToolInvocationSettlement> {
    const advertisement = registry.advertise().find((tool) => tool.name === toolCall.toolName);
    if (advertisement === undefined) {
        return failedToolCallSettlement(toolCall, protocolError('tool_failed', `unknown tool: ${toolCall.toolName}`));
    }
    return registry.invoke({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        advertisedVersion: advertisement.version,
        argumentsJson: toolCall.argumentsJson,
        signal,
    });
}

export function sessionScopedToolEvent(
    event: AgentEvent,
    sessionId: string,
    modelProviderSelection: ModelProviderSelection,
): AgentEvent {
    return {
        ...event,
        sessionId,
        modelProviderSelection: event.modelProviderSelection ?? modelProviderSelection,
    };
}

export function providerToolLoopLimitError(limit: number): ProtocolError {
    return protocolError('tool_failed', `provider turn tool loop limit exceeded: ${limit}`);
}

function providerMessageToAgentMessage(message: ProviderMessage): AgentMessage {
    return AgentMessageSchema.parse({
        role: 'assistant',
        content: message.content,
        ...(message.providerToolCalls !== undefined ? { providerToolCalls: message.providerToolCalls } : {}),
    });
}

function toolResultToAgentMessage(result: ToolInvocationSettlement['result']): AgentMessage {
    return AgentMessageSchema.parse({
        role: 'tool',
        toolCallId: result.toolCallId,
        status: result.status,
        ...(result.output !== undefined ? { output: result.output } : {}),
        ...(result.error !== undefined ? { error: result.error } : {}),
        ...(result.redactions !== undefined ? { redactions: result.redactions } : {}),
    });
}

function failedToolCallSettlement(toolCall: ToolCall, error: ProtocolError): ToolInvocationSettlement {
    return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        result: ToolResultSchema.parse({
            toolCallId: toolCall.toolCallId,
            status: 'failed',
            error,
        }),
        events: [toolEvent('tool.failed', toolCall.toolCallId, `tool failed: ${toolCall.toolName}`)],
    };
}

function toolEvent(type: 'tool.failed', toolCallId: string, message: string): AgentEvent {
    return {
        type,
        timestamp: new Date().toISOString(),
        taskId: toolCallId,
        message,
        nativeSidecarStatus: 'mock',
    };
}

function protocolError(code: ProtocolError['code'], message: string): ProtocolError {
    return {
        code,
        message,
        retryable: false,
    };
}
