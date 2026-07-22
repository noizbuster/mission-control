import type { AgentMessage } from '@mission-control/protocol';
import type { ModelMessage, ToolCallPart } from 'ai';

export function agentMessagesToSeedModelMessages(messages: readonly AgentMessage[]): ModelMessage[] {
    const toolNameByCallId = new Map<string, string>();
    const seed: ModelMessage[] = [];
    for (const message of messages) {
        if (message.role === 'system') {
            seed.push({ role: 'system', content: message.content });
        } else if (message.role === 'user') {
            seed.push({ role: 'user', content: message.content });
        } else if (message.role === 'assistant') {
            const providerToolCalls = message.providerToolCalls ?? [];
            const toolCallParts: ToolCallPart[] = [];
            for (const call of providerToolCalls) {
                let input: unknown;
                try {
                    input = JSON.parse(call.argumentsJson);
                } catch (error) {
                    if (error instanceof SyntaxError) {
                        continue;
                    }
                    throw error;
                }
                toolCallParts.push({
                    type: 'tool-call',
                    toolCallId: call.toolCallId,
                    toolName: call.toolName,
                    input,
                });
                toolNameByCallId.set(call.toolCallId, call.toolName);
            }
            if (toolCallParts.length === 0 && providerToolCalls.length > 0 && message.content === '') {
                continue;
            }
            seed.push({
                role: 'assistant',
                content:
                    toolCallParts.length === 0
                        ? message.content
                        : [
                              ...(message.content === '' ? [] : [{ type: 'text' as const, text: message.content }]),
                              ...toolCallParts,
                          ],
            });
        } else if (message.role === 'tool') {
            const toolName = toolNameByCallId.get(message.toolCallId);
            if (toolName === undefined) {
                continue;
            }
            toolNameByCallId.delete(message.toolCallId);
            seed.push({
                role: 'tool',
                content: [
                    {
                        type: 'tool-result',
                        toolCallId: message.toolCallId,
                        toolName,
                        output: toolResultOutputFor(message),
                    },
                ],
            });
        }
    }
    return seed;
}

function toolResultOutputFor(
    message: Extract<AgentMessage, { readonly role: 'tool' }>,
): { readonly type: 'text'; readonly value: string } | { readonly type: 'error-text'; readonly value: string } {
    if (message.status === 'failed') {
        const error = message.error;
        return { type: 'error-text', value: error?.message ?? 'tool failed' };
    }
    return { type: 'text', value: message.output ?? '' };
}
