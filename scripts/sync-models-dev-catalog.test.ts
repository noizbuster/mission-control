import { describe, expect, it } from 'vitest';
import { buildModelsDevCatalogSnapshot } from './sync-models-dev-catalog.js';

describe('sync-models-dev-catalog', () => {
    it('builds a deterministic provider snapshot from Models.dev data', () => {
        const snapshot = buildModelsDevCatalogSnapshot({
            zed: {
                name: 'Zed Provider',
                env: ['ZED_API_KEY'],
                models: {
                    beta: { name: 'Beta Model' },
                    alpha: { name: 'Alpha Model' },
                },
            },
            alpha: {
                name: 'Alpha Provider',
                env: ['ALPHA_TOKEN'],
                models: {
                    gamma: { name: 'Gamma Model' },
                },
            },
        });

        expect(snapshot.providers.map((provider) => provider.id)).toEqual(['alpha', 'zed']);
        expect(snapshot.providers[1]?.models.map((model) => model.id)).toEqual(['alpha', 'beta']);
        expect(snapshot.providers[0]?.authFields).toEqual([
            {
                id: 'apiKey',
                label: 'ALPHA_TOKEN',
                env: ['ALPHA_TOKEN'],
                secret: true,
                required: true,
            },
        ]);
    });

    it('uses explicit auth-field overrides for multi-env providers', () => {
        const snapshot = buildModelsDevCatalogSnapshot({
            'cloudflare-ai-gateway': {
                name: 'Cloudflare AI Gateway',
                env: ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_GATEWAY_ID'],
                models: {
                    '@cf/meta/llama': { name: 'Llama' },
                },
            },
        });

        expect(snapshot.providers[0]?.authFields).toEqual([
            {
                id: 'apiToken',
                label: 'Cloudflare API token',
                env: ['CLOUDFLARE_API_TOKEN'],
                secret: true,
                required: true,
            },
            {
                id: 'accountId',
                label: 'Cloudflare account ID',
                env: ['CLOUDFLARE_ACCOUNT_ID'],
                secret: false,
                required: true,
            },
            {
                id: 'gatewayId',
                label: 'Cloudflare gateway ID',
                env: ['CLOUDFLARE_GATEWAY_ID'],
                secret: false,
                required: true,
            },
        ]);
    });
});
