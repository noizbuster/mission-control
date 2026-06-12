import type { ProviderStreamChunk, ProviderToolCallTranscript, ToolCall } from '@mission-control/protocol';
import {
    type OpenAICompatibleErrorRedactor,
    protocolErrorFromOpenAICompatibleError,
} from './openai-compatible-errors.js';
import type { OpenAICompatibleToolCallDelta, OpenAICompatibleUsage } from './openai-compatible-event-schemas.js';
import { parseOpenAICompatibleStreamEvent } from './openai-compatible-events.js';

export type OpenAICompatibleMappingState = {
    readonly requestId: string;
    readonly providerID: string;
    nextSequence: number;
    providerResponseId?: string;
    text: string;
    responseStarted: boolean;
    responseCompleted: boolean;
    readonly toolCallsByIndex: Map<number, ToolCallAccumulator>;
    readonly completedToolCalls: Map<string, ProviderToolCallTranscript>;
};

type ToolCallAccumulator = {
    index: number;
    toolCallId?: string;
    toolName?: string;
    argumentsJson: string;
};

export function createOpenAICompatibleMappingState(
    requestId: string,
    providerID: string,
): OpenAICompatibleMappingState {
    return {
        requestId,
        providerID,
        nextSequence: 1,
        text: '',
        responseStarted: false,
        responseCompleted: false,
        toolCallsByIndex: new Map(),
        completedToolCalls: new Map(),
    };
}

export function* mapOpenAICompatibleStreamEvent(
    rawEvent: unknown,
    state: OpenAICompatibleMappingState,
    redactForOutput: OpenAICompatibleErrorRedactor,
): Iterable<ProviderStreamChunk> {
    const event = parseOpenAICompatibleStreamEvent(rawEvent);
    const sequence = state.nextSequence;
    state.nextSequence += 1;

    if (event.type === 'error') {
        yield {
            kind: 'response_failed',
            requestId: state.requestId,
            sequence,
            sourceEventType: 'error',
            providerResponseId: state.providerResponseId ?? 'unknown',
            error: protocolErrorFromOpenAICompatibleError(event.error, redactForOutput),
        };
        return;
    }

    if (event.id !== undefined) {
        state.providerResponseId = event.id;
    }
    if (!state.responseStarted && state.providerResponseId !== undefined) {
        state.responseStarted = true;
        yield {
            kind: 'response_started',
            requestId: state.requestId,
            sequence,
            sourceEventType: 'chat.completion.chunk',
            providerResponseId: state.providerResponseId,
        };
    }

    for (const choice of event.choices) {
        if (choice.delta.content !== undefined && choice.delta.content !== null) {
            state.text += choice.delta.content;
            yield {
                kind: 'text_delta',
                requestId: state.requestId,
                sequence,
                sourceEventType: 'chat.completion.chunk',
                providerResponseId: state.providerResponseId ?? 'unknown',
                delta: choice.delta.content,
            };
        }
        for (const toolCall of choice.delta.tool_calls ?? []) {
            yield* updateToolCall(state, toolCall, sequence);
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
            yield* completeForFinishReason(state, choice.finish_reason, sequence, event.usage);
        }
    }
}

function* updateToolCall(
    state: OpenAICompatibleMappingState,
    delta: OpenAICompatibleToolCallDelta,
    sequence: number,
): Iterable<ProviderStreamChunk> {
    const toolCall = rememberToolCall(state, delta);
    const argumentsDelta = delta.function?.arguments;
    if (argumentsDelta === undefined || argumentsDelta.length === 0) {
        return;
    }
    toolCall.argumentsJson += argumentsDelta;
    yield {
        kind: 'tool_call_delta',
        requestId: state.requestId,
        sequence,
        sourceEventType: 'chat.completion.chunk',
        providerResponseId: state.providerResponseId ?? 'unknown',
        toolCallId: toolCall.toolCallId ?? `tool_call_${delta.index}`,
        ...(toolCall.toolCallId !== undefined ? { providerCallId: toolCall.toolCallId } : {}),
        argumentsDelta,
    };
}

function rememberToolCall(
    state: OpenAICompatibleMappingState,
    delta: OpenAICompatibleToolCallDelta,
): ToolCallAccumulator {
    const toolCall = state.toolCallsByIndex.get(delta.index) ?? { index: delta.index, argumentsJson: '' };
    if (delta.id !== undefined) {
        toolCall.toolCallId = delta.id;
    }
    if (delta.function?.name !== undefined) {
        toolCall.toolName = delta.function.name;
    }
    state.toolCallsByIndex.set(delta.index, toolCall);
    return toolCall;
}

function* completeForFinishReason(
    state: OpenAICompatibleMappingState,
    finishReason: string,
    sequence: number,
    usage: OpenAICompatibleUsage | undefined,
): Iterable<ProviderStreamChunk> {
    if (finishReason === 'tool_calls') {
        for (const toolCall of state.toolCallsByIndex.values()) {
            const completed = completeToolCall(state, toolCall);
            if (completed !== undefined) {
                yield completedChunk(state, completed, sequence);
            }
        }
    }
    if (state.responseCompleted) {
        return;
    }
    state.responseCompleted = true;
    yield {
        kind: 'response_completed',
        requestId: state.requestId,
        sequence,
        sourceEventType: 'chat.completion.chunk',
        providerResponseId: state.providerResponseId ?? 'unknown',
        message: {
            messageId: `message_${state.providerResponseId ?? state.requestId}`,
            role: 'assistant',
            content: state.text,
            ...providerToolCallFields(state),
        },
        finishReason: finishReason === 'tool_calls' ? 'tool_calls' : 'stop',
        ...usageField(usage),
    };
}

function completeToolCall(state: OpenAICompatibleMappingState, toolCall: ToolCallAccumulator): ToolCall | undefined {
    if (
        toolCall.toolCallId === undefined ||
        toolCall.toolName === undefined ||
        toolCall.argumentsJson.length === 0 ||
        state.completedToolCalls.has(toolCall.toolCallId)
    ) {
        return undefined;
    }
    state.completedToolCalls.set(toolCall.toolCallId, {
        providerID: state.providerID,
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        argumentsJson: toolCall.argumentsJson,
        providerCallId: toolCall.toolCallId,
    });
    return {
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        argumentsJson: toolCall.argumentsJson,
        providerCallId: toolCall.toolCallId,
    };
}

function completedChunk(
    state: OpenAICompatibleMappingState,
    toolCall: ToolCall,
    sequence: number,
): ProviderStreamChunk {
    return {
        kind: 'tool_call_completed',
        requestId: state.requestId,
        sequence,
        sourceEventType: 'chat.completion.chunk',
        providerResponseId: state.providerResponseId ?? 'unknown',
        toolCall,
    };
}

function providerToolCallFields(state: OpenAICompatibleMappingState): {
    readonly toolCallIds?: string[];
    readonly providerToolCalls?: ProviderToolCallTranscript[];
} {
    const providerToolCalls: ProviderToolCallTranscript[] = [...state.completedToolCalls.values()];
    return providerToolCalls.length === 0
        ? {}
        : {
              toolCallIds: providerToolCalls.map((toolCall) => toolCall.toolCallId),
              providerToolCalls,
          };
}

function usageField(usage: OpenAICompatibleUsage | undefined): {
    readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number };
} {
    return usage?.prompt_tokens === undefined ||
        usage.completion_tokens === undefined ||
        usage.total_tokens === undefined
        ? {}
        : {
              usage: {
                  inputTokens: usage.prompt_tokens,
                  outputTokens: usage.completion_tokens,
                  totalTokens: usage.total_tokens,
              },
          };
}
