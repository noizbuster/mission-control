import type { ProviderStreamChunk } from '@mission-control/protocol';
import {
    parseGeminiFunctionCallPart,
    parseGeminiGenerateContentEvent,
    parseGeminiTextPart,
} from './gemini-generate-content-events.js';
import type { GeminiGenerateContentMappingState, GeminiToolCallState } from './gemini-generate-content-state.js';
import {
    addToolCall,
    createGeminiGenerateContentMappingState,
    finishReasonFromGemini,
    providerResponseId,
    providerToolCallMessageFields,
    usageFromState,
} from './gemini-generate-content-state.js';

export { createGeminiGenerateContentMappingState, type GeminiGenerateContentMappingState };

export function* mapGeminiGenerateContentStreamEvent(
    rawEvent: unknown,
    state: GeminiGenerateContentMappingState,
): Iterable<ProviderStreamChunk> {
    const event = parseGeminiGenerateContentEvent(rawEvent);
    if (event.responseId !== undefined) {
        state.providerResponseId = event.responseId;
    }
    updateUsage(state, event.usageMetadata);
    if (!state.started) {
        state.started = true;
        yield {
            kind: 'response_started',
            requestId: state.requestId,
            sequence: nextSequence(state),
            sourceEventType: 'generateContentResponse',
            ...providerResponseId(state.providerResponseId),
        };
    }

    for (const candidate of event.candidates) {
        for (const [partIndex, part] of candidate.parts.entries()) {
            yield* mapPart(state, candidate.index ?? 0, partIndex, part);
        }
        if (candidate.finishReason !== undefined) {
            state.stopReason = candidate.finishReason;
            yield completedChunk(state);
        }
    }
}

function* mapPart(
    state: GeminiGenerateContentMappingState,
    candidateIndex: number,
    partIndex: number,
    part: unknown,
): Iterable<ProviderStreamChunk> {
    const text = parseGeminiTextPart(part);
    if (text !== undefined) {
        state.text += text;
        yield {
            kind: 'text_delta',
            requestId: state.requestId,
            sequence: nextSequence(state),
            sourceEventType: 'candidate.part.text',
            ...providerResponseId(state.providerResponseId),
            delta: text,
        };
        return;
    }
    const functionCall = parseGeminiFunctionCallPart(part);
    if (functionCall === undefined) {
        return;
    }
    const providerItemId = `${candidateIndex}:${partIndex}`;
    const toolCall: GeminiToolCallState = {
        toolCallId: functionCall.id ?? `gemini_call_${providerItemId}`,
        toolName: functionCall.name,
        argumentsJson: JSON.stringify(functionCall.args),
        providerItemId,
        ...(functionCall.id !== undefined ? { providerCallId: functionCall.id } : {}),
    };
    addToolCall(state, toolCall);
    yield {
        kind: 'tool_call_delta',
        requestId: state.requestId,
        sequence: nextSequence(state),
        sourceEventType: 'candidate.part.functionCall',
        ...providerResponseId(state.providerResponseId),
        toolCallId: toolCall.toolCallId,
        ...(toolCall.providerCallId !== undefined ? { providerCallId: toolCall.providerCallId } : {}),
        providerItemId: toolCall.providerItemId,
        argumentsDelta: toolCall.argumentsJson,
    };
    yield {
        kind: 'tool_call_completed',
        requestId: state.requestId,
        sequence: nextSequence(state),
        sourceEventType: 'candidate.part.functionCall',
        ...providerResponseId(state.providerResponseId),
        toolCall: {
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName,
            argumentsJson: toolCall.argumentsJson,
            ...(toolCall.providerCallId !== undefined ? { providerCallId: toolCall.providerCallId } : {}),
            providerItemId: toolCall.providerItemId,
        },
    };
}

function completedChunk(
    state: GeminiGenerateContentMappingState,
): Extract<ProviderStreamChunk, { readonly kind: 'response_completed' }> {
    return {
        kind: 'response_completed',
        requestId: state.requestId,
        sequence: nextSequence(state),
        sourceEventType: 'candidate.finishReason',
        ...providerResponseId(state.providerResponseId),
        message: {
            messageId: state.providerResponseId ?? `message_${state.requestId}`,
            role: 'assistant',
            content: state.text,
            ...providerToolCallMessageFields(state),
        },
        finishReason: finishReasonFromGemini(state),
        usage: usageFromState(state),
    };
}

function nextSequence(state: GeminiGenerateContentMappingState): number {
    const sequence = state.nextSequence;
    state.nextSequence = sequence + 1;
    return sequence;
}

function updateUsage(
    state: GeminiGenerateContentMappingState,
    usage:
        | {
              readonly promptTokenCount?: number | undefined;
              readonly candidatesTokenCount?: number | undefined;
              readonly totalTokenCount?: number | undefined;
          }
        | undefined,
): void {
    if (usage?.promptTokenCount !== undefined) {
        state.inputTokens = usage.promptTokenCount;
    }
    if (usage?.candidatesTokenCount !== undefined) {
        state.outputTokens = usage.candidatesTokenCount;
    }
    if (usage?.totalTokenCount !== undefined) {
        state.totalTokens = usage.totalTokenCount;
    } else {
        state.totalTokens = state.inputTokens + state.outputTokens;
    }
}
