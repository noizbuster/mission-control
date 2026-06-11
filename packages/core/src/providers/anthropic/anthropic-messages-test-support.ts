import type { AgentMessage, ProviderStreamChunk, ToolDefinition } from '@mission-control/protocol';
import type { ProviderTurnRequest } from '../provider-turn-types.js';
import type { AnthropicMessagesTransport, AnthropicMessagesTransportRequest } from './anthropic-messages-provider.js';

export function anthropicCredential(providerID: string, apiKey: string) {
    return {
        providerID,
        type: 'apiKey' as const,
        apiKey,
        createdAt: '2026-06-09T10:00:00.000Z',
        updatedAt: '2026-06-09T10:00:00.000Z',
    };
}

export function anthropicTurnRequest(
    input: {
        readonly requestId?: string;
        readonly messages?: readonly AgentMessage[];
        readonly tools?: readonly ToolDefinition[];
    } = {},
): ProviderTurnRequest {
    return {
        requestId: input.requestId ?? 'request_anthropic',
        sessionId: 'session_anthropic',
        turnId: 'turn_anthropic',
        providerID: 'anthropic',
        modelID: 'claude-sonnet-4-6',
        messages: input.messages ?? [{ role: 'user', content: 'say hello' }],
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
    };
}

export function readToolDefinition(): ToolDefinition {
    return {
        name: 'repo_read',
        description: 'Read a file',
        parametersJsonSchema: {
            type: 'object',
            properties: {
                path: { type: 'string' },
            },
            required: ['path'],
        },
    };
}

export function transportFromEvents(
    requests: AnthropicMessagesTransportRequest[],
    events: readonly unknown[],
): AnthropicMessagesTransport {
    return {
        async *stream(request) {
            requests.push(request);
            for (const event of events) {
                yield event;
            }
        },
    };
}

export function transportFromTurnEvents(
    requests: AnthropicMessagesTransportRequest[],
    turns: readonly (readonly unknown[])[],
): AnthropicMessagesTransport {
    return {
        async *stream(request) {
            requests.push(request);
            const events = turns[requests.length - 1] ?? [];
            for (const event of events) {
                yield event;
            }
        },
    };
}

export function throwingStream(error: Error): AsyncIterable<unknown> {
    return {
        [Symbol.asyncIterator](): AsyncIterator<unknown> {
            return {
                async next() {
                    throw error;
                },
            };
        },
    };
}

export async function collectChunks(
    stream: AsyncIterable<ProviderStreamChunk>,
): Promise<readonly ProviderStreamChunk[]> {
    const chunks: ProviderStreamChunk[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return chunks;
}

export async function captureError(action: Promise<unknown>): Promise<unknown> {
    try {
        await action;
        return undefined;
    } catch (error) {
        return error;
    }
}
