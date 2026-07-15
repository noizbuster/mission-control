import type { AgentMessage } from '@mission-control/protocol';
import type { ModelMessage } from 'ai';

export function agentMessagesToSeedModelMessages(messages: readonly AgentMessage[]): ModelMessage[] {
    const toolNameByCallId = new Map<string, string>();
    for (const message of messages) {
        if (message.role === 'assistant') {
            for (const call of message.providerToolCalls ?? []) {
                toolNameByCallId.set(call.toolCallId, call.toolName);
            }
        }
    }
    const seed: ModelMessage[] = [];
    for (const message of messages) {
        if (message.role === 'system') {
            seed.push({ role: 'system', content: message.content });
        } else if (message.role === 'user') {
            seed.push({ role: 'user', content: message.content });
        } else if (message.role === 'assistant') {
            seed.push({ role: 'assistant', content: message.content });
        } else if (message.role === 'tool') {
            const toolName = toolNameByCallId.get(message.toolCallId);
            if (toolName === undefined) {
                continue;
            }
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
