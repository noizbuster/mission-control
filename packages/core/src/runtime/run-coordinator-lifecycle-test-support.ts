import type { ProviderStreamChunk } from '@mission-control/protocol';
import type { ProviderTurnRequest } from '../providers/provider-turn-types.js';

export { openCoordinatorContext } from './run-coordinator-test-support.js';

export function toolCallChunk(
    request: ProviderTurnRequest,
    toolCallId: string,
    toolName: string,
    args: Readonly<Record<string, unknown>>,
): ProviderStreamChunk {
    return {
        kind: 'tool_call_completed',
        requestId: request.requestId,
        sequence: 1,
        toolCall: {
            toolCallId,
            toolName,
            argumentsJson: JSON.stringify(args),
        },
    };
}
export function completedChunk(
    request: ProviderTurnRequest,
    content: string,
    toolCallIds?: readonly string[],
): ProviderStreamChunk {
    return {
        kind: 'response_completed',
        requestId: request.requestId,
        sequence: 2,
        message: {
            messageId: `assistant_${request.turnId}`,
            role: 'assistant',
            content,
            ...(toolCallIds !== undefined ? { toolCallIds: [...toolCallIds] } : {}),
        },
        finishReason: toolCallIds === undefined ? 'stop' : 'tool_calls',
    };
}
