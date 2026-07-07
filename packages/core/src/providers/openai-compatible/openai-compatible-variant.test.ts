import type { ProviderStreamChunk } from '@mission-control/protocol';
import { describe, expect, it } from 'vitest';
import { createStaticProviderCredentialResolver } from '../credential-resolver.js';
import type { ProviderTurnRequest } from '../provider-turn-types.js';
import {
    createOpenAICompatibleProvider,
    type OpenAICompatibleTransport,
    type OpenAICompatibleTransportRequest,
} from './openai-compatible-provider.js';

describe('OpenAI-compatible provider reasoning variants', () => {
    it.each([
        ['openrouter', '~anthropic/claude-fable-latest', 'reasoning-high'],
        ['openrouter', '~google/gemini-pro-latest', 'reasoning-low'],
        ['openrouter', '~google/gemini-flash-latest', 'reasoning-medium'],
    ] as const)('maps %s %s reasoning variant into reasoning object body field', async (providerID, modelID, variantID) => {
        const requests: OpenAICompatibleTransportRequest[] = [];
        const provider = createProviderWithRequests(providerID, requests);

        await collectChunks(provider.streamTurn(turnRequest({ providerID, modelID, variantID }), providerContext()));

        expect(hasOwn(requests[0]?.body, 'reasoning')).toBe(true);
        expect(hasOwn(requests[0]?.body, 'reasoning_effort')).toBe(false);
        expect(requests[0]?.body.reasoning).toEqual({
            effort: variantID.replace('reasoning-', ''),
        });
    });

    it.each([
        ['groq', 'qwen/qwen3-32b', 'reasoning-none', 'none'],
        ['groq', 'qwen/qwen3-32b', 'reasoning-default', 'default'],
        ['groq', 'openai/gpt-oss-120b', 'reasoning-low', 'low'],
        ['groq', 'openai/gpt-oss-120b', 'reasoning-medium', 'medium'],
        ['groq', 'openai/gpt-oss-120b', 'reasoning-high', 'high'],
    ] as const)('maps %s %s reasoning variant into reasoning_effort scalar body field', async (providerID, modelID, variantID, expected) => {
        const requests: OpenAICompatibleTransportRequest[] = [];
        const provider = createProviderWithRequests(providerID, requests);

        await collectChunks(provider.streamTurn(turnRequest({ providerID, modelID, variantID }), providerContext()));

        expect(hasOwn(requests[0]?.body, 'reasoning_effort')).toBe(true);
        expect(hasOwn(requests[0]?.body, 'reasoning')).toBe(false);
        expect(requests[0]?.body.reasoning_effort).toBe(expected);
    });

    it('maps mistral reasoning-high into reasoning_effort high', async () => {
        const requests: OpenAICompatibleTransportRequest[] = [];
        const provider = createProviderWithRequests('mistral', requests);

        await collectChunks(
            provider.streamTurn(
                turnRequest({ providerID: 'mistral', modelID: 'mistral-medium-2604', variantID: 'reasoning-high' }),
                providerContext(),
            ),
        );

        expect(hasOwn(requests[0]?.body, 'reasoning_effort')).toBe(true);
        expect(hasOwn(requests[0]?.body, 'reasoning')).toBe(false);
        expect(requests[0]?.body.reasoning_effort).toBe('high');
    });

    it('omits reasoning fields when no variantID is set', async () => {
        const requests: OpenAICompatibleTransportRequest[] = [];
        const provider = createProviderWithRequests('openrouter', requests);

        await collectChunks(
            provider.streamTurn(turnRequest({ providerID: 'openrouter', modelID: 'openai/gpt-5' }), providerContext()),
        );

        expect(hasOwn(requests[0]?.body, 'reasoning')).toBe(false);
        expect(hasOwn(requests[0]?.body, 'reasoning_effort')).toBe(false);
    });

    it.each([
        ['reasoning-high', { thinking: { type: 'enabled' }, reasoning_effort: 'high' }],
        ['reasoning-max', { thinking: { type: 'enabled' }, reasoning_effort: 'max' }],
    ] as const)('maps zai-coding-plan glm-5.2 %s into thinking toggle + reasoning_effort', async (variantID, expectedBody) => {
        const requests: OpenAICompatibleTransportRequest[] = [];
        const provider = createProviderWithRequests('zai-coding-plan', requests);

        await collectChunks(
            provider.streamTurn(
                turnRequest({ providerID: 'zai-coding-plan', modelID: 'glm-5.2', variantID }),
                providerContext(),
            ),
        );

        expect(requests[0]?.body.thinking).toEqual(expectedBody.thinking);
        expect(requests[0]?.body.reasoning_effort).toBe(expectedBody.reasoning_effort);
    });

    it('silently drops reasoning variant on non-reasoning zai-coding-plan model (glm-4.6)', async () => {
        const requests: OpenAICompatibleTransportRequest[] = [];
        const provider = createProviderWithRequests('zai-coding-plan', requests);

        await collectChunks(
            provider.streamTurn(
                turnRequest({ providerID: 'zai-coding-plan', modelID: 'glm-4.6', variantID: 'reasoning-high' }),
                providerContext(),
            ),
        );

        expect(hasOwn(requests[0]?.body, 'thinking')).toBe(false);
        expect(hasOwn(requests[0]?.body, 'reasoning_effort')).toBe(false);
    });

    it('silently drops stale reasoning variant on non-reasoning openrouter model', async () => {
        const requests: OpenAICompatibleTransportRequest[] = [];
        const provider = createProviderWithRequests('openrouter', requests);

        await collectChunks(
            provider.streamTurn(
                turnRequest({
                    providerID: 'openrouter',
                    modelID: 'meta-llama/llama-4-scout',
                    variantID: 'reasoning-high',
                }),
                providerContext(),
            ),
        );

        expect(hasOwn(requests[0]?.body, 'reasoning')).toBe(false);
        expect(hasOwn(requests[0]?.body, 'reasoning_effort')).toBe(false);
    });

    it('silently drops stale reasoning variant on non-reasoning groq model', async () => {
        const requests: OpenAICompatibleTransportRequest[] = [];
        const provider = createProviderWithRequests('groq', requests);

        await collectChunks(
            provider.streamTurn(
                turnRequest({ providerID: 'groq', modelID: 'llama-3.3-70b-versatile', variantID: 'reasoning-high' }),
                providerContext(),
            ),
        );

        expect(hasOwn(requests[0]?.body, 'reasoning')).toBe(false);
        expect(hasOwn(requests[0]?.body, 'reasoning_effort')).toBe(false);
    });

    it('omits reasoning fields for deepseek regardless of variantID', async () => {
        const requests: OpenAICompatibleTransportRequest[] = [];
        const provider = createProviderWithRequests('deepseek', requests);

        await collectChunks(
            provider.streamTurn(
                turnRequest({ providerID: 'deepseek', modelID: 'deepseek-chat', variantID: 'reasoning-high' }),
                providerContext(),
            ),
        );

        expect(hasOwn(requests[0]?.body, 'reasoning')).toBe(false);
        expect(hasOwn(requests[0]?.body, 'reasoning_effort')).toBe(false);
    });
});

function createProviderWithRequests(
    providerID: string,
    requests: OpenAICompatibleTransportRequest[],
): ReturnType<typeof createOpenAICompatibleProvider> {
    return createOpenAICompatibleProvider({
        credentialResolver: createStaticProviderCredentialResolver([credential(providerID, 'sk-test-secret')]),
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

function providerContext(): { readonly attempt: number; readonly signal: AbortSignal } {
    return { attempt: 1, signal: new AbortController().signal };
}

function turnRequest(input: {
    readonly providerID: string;
    readonly modelID: string;
    readonly variantID?: string;
}): ProviderTurnRequest {
    return {
        requestId: `request_${input.providerID}`,
        sessionId: `session_${input.providerID}`,
        turnId: `turn_${input.providerID}`,
        providerID: input.providerID,
        modelID: input.modelID,
        ...(input.variantID !== undefined ? { variantID: input.variantID } : {}),
        messages: [{ role: 'user', content: 'say hello' }],
    };
}

function transportFromEvents(requests: OpenAICompatibleTransportRequest[]): OpenAICompatibleTransport {
    return {
        async *stream(request) {
            requests.push(request);
            yield {
                id: 'chatcmpl_variant',
                choices: [
                    {
                        index: 0,
                        delta: { content: 'ok' },
                        finish_reason: 'stop',
                    },
                ],
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
