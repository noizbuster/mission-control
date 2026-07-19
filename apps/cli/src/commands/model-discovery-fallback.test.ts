import { describe, expect, it } from 'vitest';
import { createDefaultModelDiscovery } from './model-discovery';
import {
    createDataModelResponse,
    createFetch,
    createFetchWithStatus,
    createFieldsCredential,
    findProvider,
    type RecordedModelDiscoveryRequest,
} from './model-discovery-test-support';

describe('provider model discovery', () => {
    it('falls back when a provider has no supported model discovery API', async () => {
        const requests: RecordedModelDiscoveryRequest[] = [];
        const discovery = createDefaultModelDiscovery(createFetch(requests, createDataModelResponse(['unused'])));

        await expect(
            discovery({
                provider: findProvider('local'),
                credential: {
                    providerID: 'local',
                    type: 'apiKey',
                    apiKey: 'local_key',
                    createdAt: '2026-01-01T00:00:00.000Z',
                    updatedAt: '2026-01-01T00:00:00.000Z',
                },
            }),
        ).resolves.toBeUndefined();
        expect(requests).toEqual([]);
    });

    it('discovers models with an OAuth access token without exposing the refresh token', async () => {
        const requests: RecordedModelDiscoveryRequest[] = [];
        const discovery = createDefaultModelDiscovery(createFetch(requests, createDataModelResponse(['unused'])));

        const modelIDs = await discovery({
            provider: findProvider('openai'),
            credential: {
                providerID: 'openai',
                type: 'oauth',
                accessToken: 'openai_access_token',
                refreshToken: 'openai_refresh_token',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
            },
        });

        expect(modelIDs).toEqual(['unused']);
        expect(requests).toEqual([
            {
                url: 'https://api.openai.com/v1/models',
                headers: {
                    Authorization: 'Bearer openai_access_token',
                },
            },
        ]);
        expect(JSON.stringify({ modelIDs, requests })).not.toContain('openai_refresh_token');
    });

    it('falls back when the provider models API returns an error', async () => {
        const requests: RecordedModelDiscoveryRequest[] = [];
        const discovery = createDefaultModelDiscovery(
            createFetchWithStatus(requests, false, createDataModelResponse(['unused'])),
        );

        await expect(
            discovery({
                provider: findProvider('openai'),
                credential: createFieldsCredential('openai', 'openai_test_key'),
            }),
        ).resolves.toBeUndefined();
        expect(requests).toHaveLength(1);
    });

    it('falls back when the provider models API response is malformed', async () => {
        const requests: RecordedModelDiscoveryRequest[] = [];
        const discovery = createDefaultModelDiscovery(createFetch(requests, { message: 'not a model list' }));

        await expect(
            discovery({
                provider: findProvider('openai'),
                credential: createFieldsCredential('openai', 'openai_test_key'),
            }),
        ).resolves.toBeUndefined();
        expect(requests).toHaveLength(1);
    });
});
