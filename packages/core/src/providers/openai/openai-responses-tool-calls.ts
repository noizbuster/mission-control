import type { ProviderStreamChunk, ProviderToolCallTranscript } from '@mission-control/protocol';
import { type OpenAIFunctionCallItem, parseOpenAIFunctionCallItem } from './openai-responses-events.js';

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

export function rememberFunctionCall(
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
                    existing.toolCallId = item.call_id;
                }
            }
            return existing;
        }
    }

    const providerItemId = item?.id ?? `output_${outputIndex}`;
    const providerCallId = item?.call_id;
    const toolCall: ToolCallState = {
        toolCallId: providerCallId ?? `tool_call_${providerItemId}`,
        providerItemId,
        argumentsJson: item?.arguments ?? '',
        completed: false,
        ...(providerCallId !== undefined ? { providerCallId } : {}),
        ...(item?.name !== undefined ? { toolName: item.name } : {}),
    };
    state.toolCallsByItemId.set(providerItemId, toolCall);
    state.toolItemIdsByOutputIndex.set(outputIndex, providerItemId);
    return toolCall;
}

export function requireToolCallState(
    state: OpenAIResponsesMappingState,
    itemId: string,
    outputIndex: number,
): ToolCallState {
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

export function* completeToolCall(input: {
    readonly state: OpenAIResponsesMappingState;
    readonly toolCall: ToolCallState;
    readonly sequence: number;
    readonly sourceEventType: string;
    readonly responseId: string | undefined;
    readonly toolName: string | undefined;
}): Iterable<ProviderStreamChunk> {
    if (input.toolCall.completed) {
        return;
    }
    if (input.toolCall.providerCallId === undefined) {
        return;
    }
    input.toolCall.completed = true;
    if (input.toolName !== undefined) {
        input.toolCall.toolName = input.toolName;
    }
    yield {
        kind: 'tool_call_completed',
        requestId: input.state.requestId,
        sequence: input.sequence,
        sourceEventType: input.sourceEventType,
        ...providerResponseId(input.responseId ?? input.state.providerResponseId),
        toolCall: {
            toolCallId: input.toolCall.toolCallId,
            toolName: input.toolCall.toolName ?? 'unknown_function',
            argumentsJson: input.toolCall.argumentsJson,
            ...providerCallId(input.toolCall.providerCallId),
            providerItemId: input.toolCall.providerItemId,
        },
    };
}

export function* completeToolCallsFromResponseOutput(input: {
    readonly state: OpenAIResponsesMappingState;
    readonly sequence: number;
    readonly sourceEventType: string;
    readonly responseId: string;
    readonly output: readonly unknown[];
}): Iterable<ProviderStreamChunk> {
    for (const [outputIndex, rawItem] of input.output.entries()) {
        const item = parseOpenAIFunctionCallItem(rawItem);
        if (item === undefined) {
            continue;
        }
        const toolCall = rememberFunctionCall(input.state, outputIndex, item);
        toolCall.argumentsJson = item.arguments;
        yield* completeToolCall({ ...input, toolCall, toolName: item.name });
    }
}

export function providerResponseId(providerResponse: string | undefined): { readonly providerResponseId?: string } {
    return providerResponse === undefined ? {} : { providerResponseId: providerResponse };
}

export function providerCallId(providerCall: string | undefined): { readonly providerCallId?: string } {
    return providerCall === undefined ? {} : { providerCallId: providerCall };
}

export function providerToolCallMessageFields(state: OpenAIResponsesMappingState): {
    readonly toolCallIds?: string[];
    readonly providerToolCalls?: ProviderToolCallTranscript[];
} {
    const providerToolCalls = Array.from(state.toolCallsByItemId.values())
        .filter((toolCall) => toolCall.completed)
        .map((toolCall) => ({
            providerID: 'openai',
            toolCallId: toolCall.toolCallId,
            toolName: toolCall.toolName ?? 'unknown_function',
            argumentsJson: toolCall.argumentsJson,
            ...(toolCall.providerCallId !== undefined ? { providerCallId: toolCall.providerCallId } : {}),
            providerItemId: toolCall.providerItemId,
        }));
    return providerToolCalls.length === 0
        ? {}
        : {
              toolCallIds: providerToolCalls.map((toolCall) => toolCall.toolCallId),
              providerToolCalls,
          };
}
