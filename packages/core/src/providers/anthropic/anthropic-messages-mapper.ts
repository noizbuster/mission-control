import type { ProviderStreamChunk } from '@mission-control/protocol';
import { type AnthropicMessagesErrorRedactor, protocolErrorFromAnthropicError } from './anthropic-messages-errors.js';
import { parseAnthropicMessagesStreamEvent, parseAnthropicToolUseContentBlock } from './anthropic-messages-events.js';
import {
    type AnthropicMessagesMappingState,
    completedText,
    createAnthropicMessagesMappingState,
    finishReasonFromAnthropicStopReason,
    providerResponseId,
    providerToolCallMessageFields,
    toolArgumentsJson,
    updateUsage,
} from './anthropic-messages-state.js';

export { type AnthropicMessagesMappingState, createAnthropicMessagesMappingState };

const TYPE_FIELD = 'type';
const TEXT_FIELD = 'text';
const PARTIAL_JSON_FIELD = 'partial_json';

export function* mapAnthropicMessagesStreamEvent(
    rawEvent: unknown,
    state: AnthropicMessagesMappingState,
    redactForOutput: AnthropicMessagesErrorRedactor,
): Iterable<ProviderStreamChunk> {
    const event = parseAnthropicMessagesStreamEvent(rawEvent);
    const sequence = state.nextSequence;
    state.nextSequence = sequence + 1;

    switch (event.type) {
        case 'message_start':
            state.providerMessageId = event.message.id;
            updateUsage(state, event.message.usage);
            yield {
                kind: 'response_started',
                requestId: state.requestId,
                sequence,
                sourceEventType: event.type,
                providerResponseId: event.message.id,
            };
            return;
        case 'content_block_start':
            rememberContentBlock(state, event.index, event.content_block);
            return;
        case 'content_block_delta':
            yield* handleContentBlockDelta(state, event.index, event.delta, sequence, event.type);
            return;
        case 'content_block_stop':
            yield* completeToolUseBlock(state, event.index, sequence, event.type);
            return;
        case 'message_delta':
            if (event.delta.stop_reason !== undefined && event.delta.stop_reason !== null) {
                state.stopReason = event.delta.stop_reason;
            }
            updateUsage(state, event.usage);
            return;
        case 'message_stop':
            yield {
                kind: 'response_completed',
                requestId: state.requestId,
                sequence,
                sourceEventType: event.type,
                ...providerResponseId(state.providerMessageId),
                message: {
                    messageId: state.providerMessageId ?? `message_${state.requestId}`,
                    role: 'assistant',
                    content: completedText(state),
                    ...providerToolCallMessageFields(state),
                },
                finishReason: finishReasonFromAnthropicStopReason(state.stopReason),
                usage: {
                    inputTokens: state.inputTokens,
                    outputTokens: state.outputTokens,
                    totalTokens: state.inputTokens + state.outputTokens,
                },
            };
            return;
        case 'error':
            yield {
                kind: 'response_failed',
                requestId: state.requestId,
                sequence,
                sourceEventType: event.type,
                ...providerResponseId(state.providerMessageId),
                error: protocolErrorFromAnthropicError(event.error, redactForOutput),
            };
            return;
        default:
            return;
    }
}

function rememberContentBlock(state: AnthropicMessagesMappingState, index: number, rawBlock: unknown): void {
    const toolUse = parseAnthropicToolUseContentBlock(rawBlock);
    if (toolUse !== undefined) {
        state.blocksByIndex.set(index, {
            kind: 'tool_use',
            id: toolUse.id,
            name: toolUse.name,
            input: toolUse.input ?? {},
            inputJsonParts: [],
            completed: false,
        });
        return;
    }
    if (isTextBlock(rawBlock)) {
        state.blocksByIndex.set(index, { kind: 'text', text: rawBlock.text ?? '' });
    }
}

function* handleContentBlockDelta(
    state: AnthropicMessagesMappingState,
    index: number,
    delta: { readonly type: string },
    sequence: number,
    sourceEventType: string,
): Iterable<ProviderStreamChunk> {
    const block = state.blocksByIndex.get(index);
    if (block === undefined) {
        return;
    }
    if (delta.type === 'text_delta' && block.kind === 'text' && isTextDelta(delta)) {
        block.text += delta.text;
        yield {
            kind: 'text_delta',
            requestId: state.requestId,
            sequence,
            sourceEventType,
            ...providerResponseId(state.providerMessageId),
            delta: delta.text,
        };
        return;
    }
    if (delta.type === 'input_json_delta' && block.kind === 'tool_use' && isInputJsonDelta(delta)) {
        block.inputJsonParts.push(delta.partial_json);
        yield {
            kind: 'tool_call_delta',
            requestId: state.requestId,
            sequence,
            sourceEventType,
            ...providerResponseId(state.providerMessageId),
            toolCallId: block.id,
            providerCallId: block.id,
            providerItemId: String(index),
            argumentsDelta: delta.partial_json,
        };
    }
}

function* completeToolUseBlock(
    state: AnthropicMessagesMappingState,
    index: number,
    sequence: number,
    sourceEventType: string,
): Iterable<ProviderStreamChunk> {
    const block = state.blocksByIndex.get(index);
    if (block?.kind !== 'tool_use' || block.completed) {
        return;
    }
    block.completed = true;
    yield {
        kind: 'tool_call_completed',
        requestId: state.requestId,
        sequence,
        sourceEventType,
        ...providerResponseId(state.providerMessageId),
        toolCall: {
            toolCallId: block.id,
            toolName: block.name,
            argumentsJson: toolArgumentsJson(block),
            providerCallId: block.id,
            providerItemId: String(index),
        },
    };
}

function isTextBlock(value: unknown): value is { readonly type: 'text'; readonly text?: string } {
    return isRecord(value) && value[TYPE_FIELD] === 'text' && textFieldIsValid(value[TEXT_FIELD]);
}

function isTextDelta(value: unknown): value is { readonly type: 'text_delta'; readonly text: string } {
    return isRecord(value) && value[TYPE_FIELD] === 'text_delta' && typeof value[TEXT_FIELD] === 'string';
}

function isInputJsonDelta(
    value: unknown,
): value is { readonly type: 'input_json_delta'; readonly partial_json: string } {
    return isRecord(value) && value[TYPE_FIELD] === 'input_json_delta' && typeof value[PARTIAL_JSON_FIELD] === 'string';
}

function textFieldIsValid(value: unknown): boolean {
    return value === undefined || typeof value === 'string';
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
