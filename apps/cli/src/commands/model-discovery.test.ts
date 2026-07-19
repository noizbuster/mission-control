import { describe, expect, it } from 'vitest';
import { createDefaultModelDiscovery } from './model-discovery';
import {
    createDataModelResponse,
    createFetch,
    createFieldsCredential,
    findProvider,
    type RecordedModelDiscoveryRequest,
} from './model-discovery-test-support';

const openAICompatibleProviderCases = [
    { providerID: 'deepseek', url: 'https://api.deepseek.com/models', modelID: 'deepseek-chat' },
    { providerID: 'groq', url: 'https://api.groq.com/openai/v1/models', modelID: 'llama-3.3-70b-versatile' },
    { providerID: 'mistral', url: 'https://api.mistral.ai/v1/models', modelID: 'mistral-large-latest' },
    { providerID: 'openrouter', url: 'https://openrouter.ai/api/v1/models', modelID: 'anthropic/claude-sonnet-4.5' },
    { providerID: 'perplexity', url: 'https://api.perplexity.ai/v1/models', modelID: 'sonar' },
    { providerID: 'togetherai', url: 'https://api.together.xyz/v1/models', modelID: 'deepseek-ai/DeepSeek-R1' },
    { providerID: 'xai', url: 'https://api.x.ai/v1/models', modelID: 'grok-4' },
] as const;

describe('provider model discovery', () => {
    it('discovers OpenAI models through the provider models API', async () => {
        const requests: RecordedModelDiscoveryRequest[] = [];
        const discovery = createDefaultModelDiscovery(
            createFetch(requests, createDataModelResponse(['gpt-4.1-mini', 'gpt-4o'])),
        );
        const provider = findProvider('openai');

        const modelIDs = await discovery({
            provider,
            credential: {
                providerID: 'openai',
                type: 'fields',
                fields: {
                    apiKey: {
                        value: 'openai_test_key',
                        secret: true,
                    },
                },
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            },
        });

        expect(modelIDs).toEqual(['gpt-4.1-mini', 'gpt-4o']);
        expect(requests).toEqual([
            {
                url: 'https://api.openai.com/v1/models',
                headers: {
                    Authorization: 'Bearer openai_test_key',
                },
            },
        ]);
    });

    it('discovers Anthropic models through the provider models API', async () => {
        const requests: RecordedModelDiscoveryRequest[] = [];
        const discovery = createDefaultModelDiscovery(
            createFetch(requests, createDataModelResponse(['claude-3-5-haiku-20241022', 'claude-sonnet-4-5'])),
        );
        const provider = findProvider('anthropic');

        const modelIDs = await discovery({
            provider,
            credential: {
                providerID: 'anthropic',
                type: 'fields',
                fields: {
                    apiKey: {
                        value: 'anthropic_test_key',
                        secret: true,
                    },
                },
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            },
        });

        expect(modelIDs).toEqual(['claude-3-5-haiku-20241022', 'claude-sonnet-4-5']);
        expect(requests).toEqual([
            {
                url: 'https://api.anthropic.com/v1/models',
                headers: {
                    'anthropic-version': '2023-06-01',
                    'x-api-key': 'anthropic_test_key',
                },
            },
        ]);
    });

    it.each(openAICompatibleProviderCases)('discovers $providerID models through a bearer models API', async ({
        providerID,
        url,
        modelID,
    }) => {
        const requests: RecordedModelDiscoveryRequest[] = [];
        const discovery = createDefaultModelDiscovery(createFetch(requests, createDataModelResponse([modelID])));

        await expect(
            discovery({
                provider: findProvider(providerID),
                credential: createFieldsCredential(providerID, `${providerID}_test_key`),
            }),
        ).resolves.toEqual([modelID]);
        expect(requests).toEqual([
            {
                url,
                headers: {
                    Authorization: `Bearer ${providerID}_test_key`,
                },
            },
        ]);
    });

    it('discovers Google Gemini models through the Gemini models API', async () => {
        const requests: RecordedModelDiscoveryRequest[] = [];
        const discovery = createDefaultModelDiscovery(
            createFetch(requests, {
                models: [{ name: 'models/gemini-2.5-flash' }, { name: 'models/gemini-2.5-pro' }],
            }),
        );

        await expect(
            discovery({
                provider: findProvider('google'),
                credential: createFieldsCredential('google', 'google_test_key'),
            }),
        ).resolves.toEqual(['gemini-2.5-flash', 'gemini-2.5-pro']);
        expect(requests).toEqual([
            {
                url: 'https://generativelanguage.googleapis.com/v1beta/models',
                headers: {
                    'x-goog-api-key': 'google_test_key',
                },
            },
        ]);
    });

    it('discovers Cohere models through the Cohere models API', async () => {
        const requests: RecordedModelDiscoveryRequest[] = [];
        const discovery = createDefaultModelDiscovery(
            createFetch(requests, {
                models: [{ name: 'command-a-03-2025' }, { name: 'command-r7b-12-2024' }],
            }),
        );

        await expect(
            discovery({
                provider: findProvider('cohere'),
                credential: createFieldsCredential('cohere', 'cohere_test_key'),
            }),
        ).resolves.toEqual(['command-a-03-2025', 'command-r7b-12-2024']);
        expect(requests).toEqual([
            {
                url: 'https://api.cohere.com/v1/models?page_size=1000&endpoint=chat',
                headers: {
                    Authorization: 'Bearer cohere_test_key',
                },
            },
        ]);
    });
});
