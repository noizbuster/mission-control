import type { AgentMessage, ProviderStreamChunk, ToolDefinition } from '@mission-control/protocol';
import type { ProviderTurnRequest } from '../provider-turn-types.js';
import type { OpenAICompatibleTransport, OpenAICompatibleTransportRequest } from './openai-compatible-provider.js';

export function createProviderContext(): { readonly attempt: number; readonly signal: AbortSignal } {
    return { attempt: 1, signal: new AbortController().signal };
}

export function credential(providerID: string, apiKey: string) {
    return {
        providerID,
        type: 'apiKey' as const,
        apiKey,
        createdAt: '2026-06-09T10:00:00.000Z',
        updatedAt: '2026-06-09T10:00:00.000Z',
    };
}

export function turnRequest(
    input: {
        readonly requestId?: string;
        readonly providerID?: string;
        readonly messages?: readonly AgentMessage[];
        readonly tools?: readonly ToolDefinition[];
    } = {},
): ProviderTurnRequest {
    const providerID = input.providerID ?? 'openrouter';
    return {
        requestId: input.requestId ?? `request_${providerID}`,
        sessionId: `session_${providerID}`,
        turnId: `turn_${providerID}`,
        providerID,
        modelID: providerID === 'openrouter' ? '~anthropic/claude-haiku-latest' : 'test-model',
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

export function transportFromTurns(
    requests: OpenAICompatibleTransportRequest[],
    turns: readonly (readonly unknown[])[],
): OpenAICompatibleTransport {
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

export async function collectChunks(
    stream: AsyncIterable<ProviderStreamChunk>,
): Promise<readonly ProviderStreamChunk[]> {
    const chunks: ProviderStreamChunk[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return chunks;
}
