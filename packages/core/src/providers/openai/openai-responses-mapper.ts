import type { ProviderStreamChunk } from '@mission-control/protocol';
import { type OpenAIResponsesErrorRedactor, protocolErrorFromOpenAIError } from './openai-responses-errors.js';
import {
    type OpenAIFunctionCallItem,
    parseOpenAIFunctionCallItem,
    parseOpenAIMessageOutputText,
    parseOpenAIResponsesStreamEvent,
} from './openai-responses-events.js';

type ToolCallState = {
    toolCallId: string;
    providerItemId: string;
    providerCallId?: string;
    toolName?: string;
    argumentsJson: string;
    completed: boolean;
};

export type OpenAIResponsesMappingState = {
    requestId: string;
    nextSequence: number;
    providerResponseId?: string;
    toolCallsByItemId: Map<string, ToolCallState>;
    toolItemIdsByOutputIndex: Map<number, string>;
};

export function createOpenAIResponsesMappingState(requestId: string): OpenAIResponsesMappingState {
    return {
        requestId,
        nextSequence: 0,
        toolCallsByItemId: new Map(),
        toolItemIdsByOutputIndex: new Map(),
    };
}

export function* mapOpenAIResponsesStreamEvent(
    rawEvent: unknown,
    state: OpenAIResponsesMappingState,
    redactForOutput: OpenAIResponsesErrorRedactor,
): Iterable<ProviderStreamChunk> {
    const event = parseOpenAIResponsesStreamEvent(rawEvent);
    const sequence = event.sequence_number ?? state.nextSequence;
    state.nextSequence = sequence + 1;

    switch (event.type) {
        case 'response.created':
            state.providerResponseId = event.response.id;
            yield {
                kind: 'response_started',
                requestId: state.requestId,
                sequence,
                sourceEventType: event.type,
                providerResponseId: event.response.id,
            };
            return;
        case 'response.output_text.delta':
            yield {
                kind: 'text_delta',
                requestId: state.requestId,
                sequence,
                sourceEventType: event.type,
                ...providerResponseId(event.response_id ?? state.providerResponseId),
                delta: event.delta,
            };
            return;
        case 'response.output_item.added':
            rememberFunctionCall(state, event.output_index, parseOpenAIFunctionCallItem(event.item));
            return;
        case 'response.function_call_arguments.delta': {
            const toolCall = requireToolCallState(state, event.item_id, event.output_index);
            yield {
                kind: 'tool_call_delta',
                requestId: state.requestId,
                sequence,
                sourceEventType: event.type,
                ...providerResponseId(event.response_id ?? state.providerResponseId),
                toolCallId: toolCall.toolCallId,
                ...providerCallId(toolCall.providerCallId),
                providerItemId: toolCall.providerItemId,
                argumentsDelta: event.delta,
            };
            return;
        }
        case 'response.function_call_arguments.done': {
            const toolCall = requireToolCallState(state, event.item_id, event.output_index);
            toolCall.argumentsJson = event.arguments;
            yield* completeToolCall(state, toolCall, sequence, event.type, event.response_id, event.name);
            return;
        }
        case 'response.output_item.done': {
            const item = parseOpenAIFunctionCallItem(event.item);
            if (item === undefined) {
                return;
            }
            const toolCall = rememberFunctionCall(state, event.output_index, item);
            toolCall.argumentsJson = item.arguments;
            yield* completeToolCall(state, toolCall, sequence, event.type, event.response_id, item.name);
            return;
        }
        case 'response.completed':
            state.providerResponseId = event.response.id;
            yield {
                kind: 'response_completed',
                requestId: state.requestId,
                sequence,
                sourceEventType: event.type,
                providerResponseId: event.response.id,
                message: {
                    messageId: `message_${event.response.id}`,
                    role: 'assistant',
                    content: completedResponseText(event.response.output ?? []),
                },
                finishReason: 'stop',
                ...usageFromResponse(event.response.usage),
            };
            return;
        case 'response.failed':
            yield {
                kind: 'response_failed',
                requestId: state.requestId,
                sequence,
                sourceEventType: event.type,
                ...providerResponseId(event.response?.id ?? state.providerResponseId),
                error: protocolErrorFromOpenAIError(event.error ?? event.response?.error, redactForOutput),
            };
            return;
        case 'error':
            yield {
                kind: 'response_failed',
                requestId: state.requestId,
                sequence,
                sourceEventType: event.type,
                ...providerResponseId(state.providerResponseId),
                error: protocolErrorFromOpenAIError(event, redactForOutput),
            };
            return;
        default:
            return;
    }
}

function rememberFunctionCall(
    state: OpenAIResponsesMappingState,
    outputIndex: number,
    item: OpenAIFunctionCallItem | undefined,
): ToolCallState {
    const existingItemId = item?.id ?? state.toolItemIdsByOutputIndex.get(outputIndex);
    if (existingItemId !== undefined) {
        const existing = state.toolCallsByItemId.get(existingItemId);
        if (existing !== undefined) {
            if (item !== undefined) {
                existing.toolName = item.name;
                if (item.call_id !== undefined) {
                    existing.providerCallId = item.call_id;
                }
            }
            return existing;
        }
    }

    const providerItemId = item?.id ?? `output_${outputIndex}`;
    const toolCall: ToolCallState = {
        toolCallId: `tool_call_${providerItemId}`,
        providerItemId,
        argumentsJson: item?.arguments ?? '',
        completed: false,
        ...(item?.call_id !== undefined ? { providerCallId: item.call_id } : {}),
        ...(item?.name !== undefined ? { toolName: item.name } : {}),
    };
    state.toolCallsByItemId.set(providerItemId, toolCall);
    state.toolItemIdsByOutputIndex.set(outputIndex, providerItemId);
    return toolCall;
}

function requireToolCallState(state: OpenAIResponsesMappingState, itemId: string, outputIndex: number): ToolCallState {
    const existing = state.toolCallsByItemId.get(itemId);
    if (existing !== undefined) {
        return existing;
    }
    state.toolItemIdsByOutputIndex.set(outputIndex, itemId);
    const created: ToolCallState = {
        toolCallId: `tool_call_${itemId}`,
        providerItemId: itemId,
        argumentsJson: '',
        completed: false,
    };
    state.toolCallsByItemId.set(itemId, created);
    return created;
}

function* completeToolCall(
    state: OpenAIResponsesMappingState,
    toolCall: ToolCallState,
    sequence: number,
    sourceEventType: string,
    responseId: string | undefined,
    toolName: string | undefined,
): Iterable<ProviderStreamChunk> {
    if (toolCall.completed) {
        return;
    }
    toolCall.completed = true;
    if (toolName !== undefined) {
        toolCall.toolName = toolName;
    }
    yield {
        kind: 'tool_call_completed',
        requestId: state.requestId,
        sequence,
        sourceEventType,
        ...providerResponseId(responseId ?? state.providerResponseId),
        toolCall: {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName ?? 'unknown_function',
            argumentsJson: toolCall.argumentsJson,
            ...providerCallId(toolCall.providerCallId),
            providerItemId: toolCall.providerItemId,
        },
    };
}

function providerResponseId(providerResponse: string | undefined): { readonly providerResponseId?: string } {
    return providerResponse === undefined ? {} : { providerResponseId: providerResponse };
}

function providerCallId(providerCall: string | undefined): { readonly providerCallId?: string } {
    return providerCall === undefined ? {} : { providerCallId: providerCall };
}

function completedResponseText(output: readonly unknown[]): string {
    return output
        .map(parseOpenAIMessageOutputText)
        .filter((text) => text !== undefined)
        .join('');
}

function usageFromResponse(
    usage: { readonly input_tokens: number; readonly output_tokens: number; readonly total_tokens: number } | undefined,
): { readonly usage?: { readonly inputTokens: number; readonly outputTokens: number; readonly totalTokens: number } } {
    return usage === undefined
        ? {}
        : {
              usage: {
                  inputTokens: usage.input_tokens,
                  outputTokens: usage.output_tokens,
                  totalTokens: usage.total_tokens,
              },
          };
}
