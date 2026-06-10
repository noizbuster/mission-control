import { describe, expect, it } from 'vitest';
import {
    ModelProviderSelectionSchema,
    ProviderAuthFileSchema,
    ProviderCatalogEntrySchema,
    ProviderCredentialSchema,
    ProviderCredentialSummarySchema,
} from './schema.js';

describe('provider auth and catalog schemas', () => {
    it('parses provider model selection and catalog entries', () => {
        const selection = ModelProviderSelectionSchema.parse({
            providerID: 'local',
            modelID: 'local-echo',
        });
        const provider = ProviderCatalogEntrySchema.parse({
            id: 'local',
            name: 'Local Sandbox',
            defaultModelID: 'local-echo',
            authLabel: 'API key',
            models: [
                {
                    id: 'local-echo',
                    name: 'Local Echo',
                    status: 'active',
                    variants: [
                        {
                            id: 'default',
                            name: 'Default',
                            status: 'active',
                        },
                    ],
                },
            ],
        });

        expect(selection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
        expect(provider.models[0]?.id).toBe('local-echo');
        expect(provider.models[0]?.variants?.[0]?.id).toBe('default');
    });

    it('rejects provider catalog entries with malformed model variants', () => {
        const parsed = ProviderCatalogEntrySchema.safeParse({
            id: 'local',
            name: 'Local Sandbox',
            defaultModelID: 'local-echo',
            authLabel: 'API key',
            models: [
                {
                    id: 'local-echo',
                    name: 'Local Echo',
                    variants: [
                        {
                            id: '',
                            name: 'Default',
                        },
                    ],
                },
            ],
        });

        expect(parsed.success).toBe(false);
    });

    it('parses provider credential records and auth file snapshots', () => {
        const credential = ProviderCredentialSchema.parse({
            providerID: 'local',
            type: 'apiKey',
            apiKey: 'local_test_key',
            createdAt: '2026-06-03T10:00:00.000Z',
            updatedAt: '2026-06-03T10:00:00.000Z',
        });
        const authFile = ProviderAuthFileSchema.parse({
            $schema: 'https://mission-control.local/auth.schema.json',
            default: {
                providerID: 'local',
                modelID: 'local-echo',
            },
            credentials: {
                local: credential,
            },
        });
        const summary = ProviderCredentialSummarySchema.parse({
            providerID: 'local',
            authenticated: true,
            maskedCredential: 'loca..._key',
        });

        const localProviderID = 'local';

        expect(authFile.credentials[localProviderID]).toMatchObject({
            apiKey: 'local_test_key',
        });
        expect(summary.maskedCredential).toBe('loca..._key');
        expect(
            ProviderCredentialSchema.safeParse({
                providerID: 'local',
                type: 'apiKey',
                apiKey: '',
                createdAt: '2026-06-03T10:00:00.000Z',
                updatedAt: '2026-06-03T10:00:00.000Z',
            }).success,
        ).toBe(false);
    });

    it('parses multi-field provider credentials and legacy API-key credentials', () => {
        const multiFieldCredential = ProviderCredentialSchema.parse({
            providerID: 'cloudflare-ai-gateway',
            type: 'fields',
            fields: {
                accountId: {
                    value: 'acct_test',
                    secret: false,
                },
                apiToken: {
                    value: 'cf_secret_token',
                    secret: true,
                },
                gatewayId: {
                    value: 'gw_test',
                    secret: false,
                },
            },
            createdAt: '2026-06-03T10:00:00.000Z',
            updatedAt: '2026-06-03T10:00:00.000Z',
        });
        const legacyCredential = ProviderCredentialSchema.parse({
            providerID: 'local',
            type: 'apiKey',
            apiKey: 'local_test_key',
            createdAt: '2026-06-03T10:00:00.000Z',
            updatedAt: '2026-06-03T10:00:00.000Z',
        });
        const summary = ProviderCredentialSummarySchema.parse({
            providerID: 'cloudflare-ai-gateway',
            authenticated: true,
            maskedCredential: 'cf_s...oken (3 fields)',
            credentialFieldCount: 3,
        });

        expect(multiFieldCredential).toMatchObject({
            providerID: 'cloudflare-ai-gateway',
            type: 'fields',
            fields: {
                apiToken: {
                    secret: true,
                },
            },
        });
        expect(legacyCredential).toMatchObject({
            providerID: 'local',
            type: 'apiKey',
            apiKey: 'local_test_key',
        });
        expect(summary.credentialFieldCount).toBe(3);
    });
});
