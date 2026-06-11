import type { ProviderStreamChunk } from '@mission-control/protocol';
import { type OpenAIResponsesErrorRedactor, protocolErrorFromOpenAIError } from './openai-responses-errors.js';
import {
    parseOpenAIFunctionCallItem,
    parseOpenAIMessageOutputText,
    parseOpenAIResponsesStreamEvent,
} from './openai-responses-events.js';
import {
    completeToolCall,
    completeToolCallsFromResponseOutput,
    createOpenAIResponsesMappingState,
    type OpenAIResponsesMappingState,
    providerCallId,
    providerResponseId,
    providerToolCallMessageFields,
    rememberFunctionCall,
    requireToolCallState,
} from './openai-responses-tool-calls.js';

export { createOpenAIResponsesMappingState, type OpenAIResponsesMappingState };

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
            if (event.name !== undefined) {
                toolCall.toolName = event.name;
            }
            if (toolCall.providerCallId === undefined) {
                return;
            }
            yield* completeToolCall({
                state,
                toolCall,
                sequence,
                sourceEventType: event.type,
                responseId: event.response_id,
                toolName: event.name,
            });
            return;
        }
        case 'response.output_item.done': {
            const item = parseOpenAIFunctionCallItem(event.item);
            if (item === undefined) {
                return;
            }
            const toolCall = rememberFunctionCall(state, event.output_index, item);
            toolCall.argumentsJson = item.arguments;
            yield* completeToolCall({
                state,
                toolCall,
                sequence,
                sourceEventType: event.type,
                responseId: event.response_id,
                toolName: item.name,
            });
            return;
        }
        case 'response.completed':
            state.providerResponseId = event.response.id;
            yield* completeToolCallsFromResponseOutput({
                state,
                sequence,
                sourceEventType: event.type,
                responseId: event.response.id,
                output: event.response.output ?? [],
            });
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
                    ...providerToolCallMessageFields(state),
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
