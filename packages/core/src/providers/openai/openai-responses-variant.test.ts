import type { ProviderStreamChunk } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import type { ProviderTurnRequest } from '../provider-turn-types.js';
import {
    createOpenAIResponsesProvider,
    type OpenAIResponsesTransport,
    type OpenAIResponsesTransportRequest,
} from './openai-responses-provider.js';

describe('OpenAI Responses provider variants', () => {
    it('maps reasoning effort variants into OpenAI Responses request body', async () => {
        const requests: OpenAIResponsesTransportRequest[] = [];
        const provider = createProviderWithRequests(requests);

        await collectChunks(
            provider.streamTurn(turnRequest({ variantID: 'reasoning-high' }), {
                attempt: 1,
                signal: new AbortController().signal,
            }),
        );

        expect(requests[0]?.body).toMatchObject({
            model: 'gpt-5.5',
            reasoning: { effort: 'high' },
        });
    });

    it('omits reasoning payload for non-variant requests', async () => {
        const requests: OpenAIResponsesTransportRequest[] = [];
        const provider = createProviderWithRequests(requests);

        await collectChunks(provider.streamTurn(turnRequest(), { attempt: 1, signal: new AbortController().signal }));

        expect(hasOwn(requests[0]?.body, 'reasoning')).toBe(false);
    });

    it('ignores stale reasoning variant IDs for OpenAI models without configured variants', async () => {
        const requests: OpenAIResponsesTransportRequest[] = [];
        const provider = createProviderWithRequests(requests);

        await collectChunks(
            provider.streamTurn(turnRequest({ modelID: 'gpt-4o-mini', variantID: 'reasoning-high' }), {
                attempt: 1,
                signal: new AbortController().signal,
            }),
        );

        expect(requests[0]?.body).toMatchObject({ model: 'gpt-4o-mini' });
        expect(hasOwn(requests[0]?.body, 'reasoning')).toBe(false);
    });
});

function createProviderWithRequests(requests: OpenAIResponsesTransportRequest[]) {
    return createOpenAIResponsesProvider({
        credentialResolver: createStaticProviderCredentialResolver([credential('openai', 'sk-test-secret')]),
        transport: transportFromEvents(requests),
    });
}

function credential(providerID: string, apiKey: string) {
    return {
        providerID,
        type: 'apiKey' as const,
        apiKey,
        createdAt: '2026-06-09T10:00:00.000Z',
        updatedAt: '2026-06-09T10:00:00.000Z',
    };
}

function turnRequest(input: { readonly modelID?: string; readonly variantID?: string } = {}): ProviderTurnRequest {
    return {
        requestId: 'request_openai',
        sessionId: 'session_openai',
        turnId: 'turn_openai',
        providerID: 'openai',
        modelID: input.modelID ?? 'gpt-5.5',
        ...(input.variantID !== undefined ? { variantID: input.variantID } : {}),
        messages: [{ role: 'user', content: 'say hello' }],
    };
}

function transportFromEvents(requests: OpenAIResponsesTransportRequest[]): OpenAIResponsesTransport {
    return {
        async *stream(request) {
            requests.push(request);
            yield {
                type: 'response.completed',
                sequence_number: 1,
                response: {
                    id: 'resp_variant',
                    status: 'completed',
                    output: [
                        {
                            id: 'msg_variant',
                            type: 'message',
                            role: 'assistant',
                            content: [{ type: 'output_text', text: 'variant' }],
                        },
                    ],
                },
            };
        },
    };
}

async function collectChunks(stream: AsyncIterable<ProviderStreamChunk>): Promise<ProviderStreamChunk[]> {
    const chunks: ProviderStreamChunk[] = [];
    for await (const chunk of stream) {
        chunks.push(chunk);
    }
    return chunks;
}

function hasOwn(value: object | undefined, key: string): boolean {
    return value !== undefined && Object.hasOwn(value, key);
}
