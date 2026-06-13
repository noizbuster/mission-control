import type { ProviderAdapter, ProviderTurnRequest } from '../packages/core/src/index.js';
import type { ProviderStreamChunk } from '../packages/protocol/src/index.js';

export function scriptedCodingSmokeProvider(requests: ProviderTurnRequest[] = []): ProviderAdapter {
    return {
        async *streamTurn(request) {
            requests.push(request);
            if (requests.length === 1) {
                yield toolCallChunk(request, 1, 'smoke_read_call', 'read', { path: 'src/message.txt' });
                yield toolCallChunk(request, 2, 'smoke_edit_call', 'file.edit', {
                    path: 'src/message.txt',
                    oldText: 'unique',
                    newText: 'edited',
                });
                yield toolCallChunk(request, 3, 'smoke_write_call', 'file.write', {
                    path: 'nested/generated.txt',
                    content: 'created by smoke\n',
                    createParents: true,
                });
                yield toolCallChunk(request, 4, 'smoke_bash_call', 'bash.run', {
                    commandLine: 'pwd',
                    cwd: 'nested',
                });
                yield completedChunk(request, 5, 'tools requested', [
                    'smoke_read_call',
                    'smoke_edit_call',
                    'smoke_write_call',
                    'smoke_bash_call',
                ]);
                return;
            }
            if (requests.length === 2) {
                yield toolCallChunk(request, 1, 'smoke_patch_call', 'file.patch', {
                    patch: addFilePatch('.smoke-approved.txt', 'approved'),
                });
                yield completedChunk(request, 2, 'approval required for patch', ['smoke_patch_call']);
                return;
            }
            yield completedChunk(request, 1, 'smoke resumed after approval');
        },
    };
}

function toolCallChunk(
    request: ProviderTurnRequest,
    sequence: number,
    toolCallId: string,
    toolName: string,
    argumentsValue: Readonly<Record<string, unknown>>,
): ProviderStreamChunk {
    return {
        kind: 'tool_call_completed',
        requestId: request.requestId,
        sequence,
        toolCall: {
            toolCallId,
            toolName,
            argumentsJson: JSON.stringify(argumentsValue),
        },
    };
}

function completedChunk(
    request: ProviderTurnRequest,
    sequence: number,
    content: string,
    toolCallIds?: readonly string[],
): ProviderStreamChunk {
    return {
        kind: 'response_completed',
        requestId: request.requestId,
        sequence,
        message: {
            messageId: `message_${request.turnId}_${sequence}`,
            role: 'assistant',
            content,
            ...(toolCallIds !== undefined ? { toolCallIds: [...toolCallIds] } : {}),
        },
        finishReason: toolCallIds === undefined ? 'stop' : 'tool_calls',
    };
}

function addFilePatch(path: string, content: string): string {
    return [
        `diff --git a/${path} b/${path}`,
        '--- /dev/null',
        `+++ b/${path}`,
        '@@ -0,0 +1 @@',
        `+${content}`,
        '',
    ].join('\n');
}
