import type { ProviderFinishReason, ProviderToolCallTranscript } from '@mission-control/protocol';

export type TextBlockState = {
    kind: 'text';
    text: string;
};

export type ToolUseBlockState = {
    kind: 'tool_use';
    id: string;
    name: string;
    input: Readonly<Record<string, unknown>>;
    inputJsonParts: string[];
    completed: boolean;
};

export type ContentBlockState = TextBlockState | ToolUseBlockState;

export type AnthropicMessagesMappingState = {
    requestId: string;
    nextSequence: number;
    providerMessageId?: string;
    stopReason?: string;
    inputTokens: number;
    outputTokens: number;
    blocksByIndex: Map<number, ContentBlockState>;
};

export type AnthropicUsage = {
    readonly input_tokens?: number | undefined;
    readonly output_tokens?: number | undefined;
};

export function createAnthropicMessagesMappingState(requestId: string): AnthropicMessagesMappingState {
    return {
        requestId,
        nextSequence: 0,
        inputTokens: 0,
        outputTokens: 0,
        blocksByIndex: new Map(),
    };
}

export function providerToolCallMessageFields(state: AnthropicMessagesMappingState): {
    readonly toolCallIds?: string[];
    readonly providerToolCalls?: ProviderToolCallTranscript[];
} {
    const providerToolCalls = Array.from(state.blocksByIndex.entries()).flatMap(([index, block]) =>
        block.kind === 'tool_use' && block.completed
            ? [
                  {
                      providerID: 'anthropic',
                      toolCallId: block.id,
                      toolName: block.name,
                      argumentsJson: toolArgumentsJson(block),
                      providerCallId: block.id,
                      providerItemId: String(index),
                  },
              ]
            : [],
    );
    return providerToolCalls.length === 0
        ? {}
        : {
              toolCallIds: providerToolCalls.map((toolCall) => toolCall.toolCallId),
              providerToolCalls,
          };
}

export function completedText(state: AnthropicMessagesMappingState): string {
    return Array.from(state.blocksByIndex.entries())
        .sort(([left], [right]) => left - right)
        .map((entry) => entry[1])
        .filter((block): block is TextBlockState => block.kind === 'text')
        .map((block) => block.text)
        .join('');
}

export function toolArgumentsJson(block: ToolUseBlockState): string {
    const streamed = block.inputJsonParts.join('');
    return streamed.length > 0 ? streamed : (JSON.stringify(block.input) ?? '{}');
}

export function finishReasonFromAnthropicStopReason(stopReason: string | undefined): ProviderFinishReason {
    switch (stopReason) {
        case undefined:
        case 'end_turn':
        case 'stop_sequence':
            return 'stop';
        case 'tool_use':
            return 'tool_calls';
        case 'max_tokens':
            return 'length';
        case 'refusal':
            return 'content_filter';
        default:
            return 'unknown';
    }
}

export function updateUsage(state: AnthropicMessagesMappingState, usage: AnthropicUsage | undefined): void {
    if (usage?.input_tokens !== undefined) {
        state.inputTokens = usage.input_tokens;
    }
    if (usage?.output_tokens !== undefined) {
        state.outputTokens = usage.output_tokens;
    }
}

export function providerResponseId(providerResponse: string | undefined): { readonly providerResponseId?: string } {
    return providerResponse === undefined ? {} : { providerResponseId: providerResponse };
}
