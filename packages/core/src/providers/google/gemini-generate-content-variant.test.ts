import type { ProviderStreamChunk } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import type { ProviderTurnRequest } from '../provider-turn-types.js';
import {
    createGeminiGenerateContentProvider,
    type GeminiGenerateContentTransport,
    type GeminiGenerateContentTransportRequest,
} from './gemini-generate-content-provider.js';

describe('Gemini GenerateContent provider variants', () => {
    it('maps the thinking-high variant into generationConfig.thinkingConfig', async () => {
        const requests: GeminiGenerateContentTransportRequest[] = [];
        const provider = createProviderWithRequests(requests);

        await collectChunks(
            provider.streamTurn(turnRequest({ variantID: 'thinking-high' }), {
                attempt: 1,
                signal: new AbortController().signal,
            }),
        );

        expect(requests[0]?.body.generationConfig?.thinkingConfig).toEqual({
            thinkingBudget: 24576,
            includeThoughts: true,
        });
    });

    it('maps the thinking-low variant into the low thinking budget', async () => {
        const requests: GeminiGenerateContentTransportRequest[] = [];
        const provider = createProviderWithRequests(requests);

        await collectChunks(
            provider.streamTurn(turnRequest({ variantID: 'thinking-low' }), {
                attempt: 1,
                signal: new AbortController().signal,
            }),
        );

        expect(requests[0]?.body.generationConfig?.thinkingConfig).toEqual({
            thinkingBudget: 2048,
            includeThoughts: true,
        });
    });

    it('omits generationConfig for non-variant requests', async () => {
        const requests: GeminiGenerateContentTransportRequest[] = [];
        const provider = createProviderWithRequests(requests);

        await collectChunks(provider.streamTurn(turnRequest(), { attempt: 1, signal: new AbortController().signal }));

        expect(hasOwn(requests[0]?.body, 'generationConfig')).toBe(false);
    });

    it('ignores stale thinking variant IDs for Gemini models without configured variants', async () => {
        const requests: GeminiGenerateContentTransportRequest[] = [];
        const provider = createProviderWithRequests(requests);

        await collectChunks(
            provider.streamTurn(turnRequest({ modelID: 'gemini-2.0-flash', variantID: 'thinking-high' }), {
                attempt: 1,
                signal: new AbortController().signal,
            }),
        );

        expect(requests[0]?.body).toMatchObject({ contents: [{ role: 'user', parts: [{ text: 'say hello' }] }] });
        expect(hasOwn(requests[0]?.body, 'generationConfig')).toBe(false);
    });
});

function createProviderWithRequests(requests: GeminiGenerateContentTransportRequest[]) {
    return createGeminiGenerateContentProvider({
        credentialResolver: createStaticProviderCredentialResolver([credential('google', 'sk-gemini-test-secret')]),
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
        requestId: 'request_gemini',
        sessionId: 'session_gemini',
        turnId: 'turn_gemini',
        providerID: 'google',
        modelID: input.modelID ?? 'gemini-2.5-pro',
        ...(input.variantID !== undefined ? { variantID: input.variantID } : {}),
        messages: [{ role: 'user', content: 'say hello' }],
    };
}

function transportFromEvents(requests: GeminiGenerateContentTransportRequest[]): GeminiGenerateContentTransport {
    return {
        async *stream(request) {
            requests.push(request);
            yield {
                responseId: 'resp_variant',
                candidates: [
                    {
                        index: 0,
                        content: { role: 'model', parts: [{ text: 'ok' }] },
                        finishReason: 'STOP',
                    },
                ],
                usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
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
