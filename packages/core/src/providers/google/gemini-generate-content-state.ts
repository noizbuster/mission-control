import type { ProviderFinishReason, ProviderToolCallTranscript, ProviderUsage } from '@mission-control/protocol';

export type GeminiToolCallState = {
    readonly toolCallId: string;
    readonly toolName: string;
    readonly argumentsJson: string;
    readonly providerItemId: string;
    readonly providerCallId?: string;
};

export type GeminiGenerateContentMappingState = {
    readonly requestId: string;
    nextSequence: number;
    started: boolean;
    providerResponseId?: string;
    text: string;
    stopReason?: string;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    toolCalls: readonly GeminiToolCallState[];
};

export function createGeminiGenerateContentMappingState(requestId: string): GeminiGenerateContentMappingState {
    return {
        requestId,
        nextSequence: 0,
        started: false,
        text: '',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        toolCalls: [],
    };
}

export function addToolCall(state: GeminiGenerateContentMappingState, toolCall: GeminiToolCallState): void {
    state.toolCalls = [...state.toolCalls, toolCall];
}

export function providerToolCallMessageFields(state: GeminiGenerateContentMappingState): {
    readonly toolCallIds?: string[];
    readonly providerToolCalls?: ProviderToolCallTranscript[];
} {
    return state.toolCalls.length === 0
        ? {}
        : {
              toolCallIds: state.toolCalls.map((toolCall) => toolCall.toolCallId),
              providerToolCalls: state.toolCalls.map((toolCall) => ({
                  providerID: 'google',
                  toolCallId: toolCall.toolCallId,
                  toolName: toolCall.toolName,
                  argumentsJson: toolCall.argumentsJson,
                  ...(toolCall.providerCallId !== undefined ? { providerCallId: toolCall.providerCallId } : {}),
                  providerItemId: toolCall.providerItemId,
              })),
          };
}

export function finishReasonFromGemini(state: GeminiGenerateContentMappingState): ProviderFinishReason {
    if (state.toolCalls.length > 0) {
        return 'tool_calls';
    }
    switch (state.stopReason) {
        case undefined:
        case 'STOP':
            return 'stop';
        case 'MAX_TOKENS':
            return 'length';
        case 'SAFETY':
        case 'RECITATION':
        case 'SPII':
        case 'PROHIBITED_CONTENT':
        case 'BLOCKLIST':
            return 'content_filter';
        case 'MALFORMED_FUNCTION_CALL':
            return 'error';
        default:
            return 'unknown';
    }
}

export function usageFromState(state: GeminiGenerateContentMappingState): ProviderUsage {
    return {
        inputTokens: state.inputTokens,
        outputTokens: state.outputTokens,
        totalTokens: state.totalTokens,
    };
}

export function providerResponseId(providerResponse: string | undefined): { readonly providerResponseId?: string } {
    return providerResponse === undefined ? {} : { providerResponseId: providerResponse };
}
