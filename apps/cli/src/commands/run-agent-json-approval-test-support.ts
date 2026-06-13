import type { ProviderAdapter, ProviderTurnRequest } from '@mission-control/core';
import type { ProviderStreamChunk } from '@mission-control/protocol';

export const knownSafePatchPath = '.mctrl-known-safe-automation-patch.txt';

export function providerWithWrite(path: string, content: string): ProviderAdapter {
    return {
        async *streamTurn(request) {
            yield toolCallChunk(request, 'task18_write_call', 'file.write', {
                path,
                content,
            });
            yield completedChunk(request, 'write requested', ['task18_write_call']);
        },
    };
}

export function parseJsonRecords(output: string): readonly Record<string, unknown>[] {
    return output
        .trim()
        .split('\n')
        .filter((line) => line.trim().startsWith('{'))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
}

export function lastRecord(records: readonly Record<string, unknown>[]): Record<string, unknown> {
    const record = records.at(-1);
    if (record === undefined) {
        throw new Error('expected at least one JSON record');
    }
    return record;
}

function toolCallChunk(
    request: ProviderTurnRequest,
    toolCallId: string,
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
): ProviderStreamChunk {
    return {
        kind: 'tool_call_completed',
        requestId: request.requestId,
        sequence: 1,
        toolCall: {
            toolCallId,
            toolName,
            argumentsJson: JSON.stringify(argumentsValue),
        },
    };
}

function completedChunk(
    request: ProviderTurnRequest,
    content: string,
    toolCallIds?: readonly string[],
): ProviderStreamChunk {
    return {
        kind: 'response_completed',
        requestId: request.requestId,
        sequence: 2,
        message: {
            messageId: `message_${request.turnId}`,
            role: 'assistant',
            content,
            ...(toolCallIds !== undefined ? { toolCallIds: [...toolCallIds] } : {}),
        },
        finishReason: toolCallIds === undefined ? 'stop' : 'tool_calls',
    };
}
