import type { AgentMessage, ProviderStreamChunk, ToolDefinition } from '@mission-control/protocol';
import type { ProviderTurnRequest } from '../provider-turn-types.js';
import type {
    GeminiGenerateContentTransport,
    GeminiGenerateContentTransportRequest,
} from './gemini-generate-content-provider.js';

export function geminiCredential(providerID: string, apiKey: string) {
    return {
        providerID,
        type: 'apiKey' as const,
        apiKey,
        createdAt: '2026-06-11T10:00:00.000Z',
        updatedAt: '2026-06-11T10:00:00.000Z',
    };
}

export function geminiTurnRequest(
    input: {
        readonly requestId?: string;
        readonly messages?: readonly AgentMessage[];
        readonly tools?: readonly ToolDefinition[];
    } = {},
): ProviderTurnRequest {
    return {
        requestId: input.requestId ?? 'request_gemini',
        sessionId: 'session_gemini',
        turnId: 'turn_gemini',
        providerID: 'google',
        modelID: 'gemini-3.5-flash',
        messages: input.messages ?? [{ role: 'user', content: 'say hello' }],
        ...(input.tools !== undefined ? { tools: input.tools } : {}),
    };
}

export function searchToolDefinition(): ToolDefinition {
    return {
        name: 'repo_search',
        description: 'Search repository files',
        parametersJsonSchema: {
            type: 'object',
            properties: {
                query: { type: 'string' },
            },
            required: ['query'],
        },
    };
}

export function transportFromEvents(
    requests: GeminiGenerateContentTransportRequest[],
    events: readonly unknown[],
): GeminiGenerateContentTransport {
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
    requests: GeminiGenerateContentTransportRequest[],
    turns: readonly (readonly unknown[])[],
): GeminiGenerateContentTransport {
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
