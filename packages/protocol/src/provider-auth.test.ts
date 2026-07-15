import { describe, expect, it } from 'vitest';
import {
    MODEL_ROLE_IDS,
    ModelRoleAssignmentsSchema,
    ModelRoleSchema,
    ProviderExecutionCapabilitySchema,
} from './provider-auth';
import {
    ModelProviderSelectionSchema,
    ProviderAuthFileSchema,
    ProviderCatalogEntrySchema,
    ProviderCredentialSchema,
    ProviderCredentialSummarySchema,
} from './schema';

describe('provider auth and catalog schemas', () => {
    it('parses provider model selection and catalog entries', () => {
        const selection = ModelProviderSelectionSchema.parse({
            providerID: 'local',
            modelID: 'local-echo',
            variantID: 'fast',
        });
        const provider = ProviderCatalogEntrySchema.parse({
            id: 'local',
            name: 'Local Sandbox',
            defaultModelID: 'local-echo',
            authLabel: 'API key',
            capability: {
                status: 'executable',
                adapterFamily: 'local',
            },
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
            variantID: 'fast',
        });
        expect(provider.models[0]?.id).toBe('local-echo');
        expect(provider.models[0]?.variants?.[0]?.id).toBe('default');
    });

    it('parses explicit provider execution capability metadata', () => {
        expect(
            ProviderExecutionCapabilitySchema.parse({
                status: 'executable',
                adapterFamily: 'openai-responses',
            }),
        ).toEqual({
            status: 'executable',
            adapterFamily: 'openai-responses',
        });
        expect(ProviderExecutionCapabilitySchema.parse({ status: 'model-discovery-only' })).toEqual({
            status: 'model-discovery-only',
        });
        expect(ProviderExecutionCapabilitySchema.safeParse({ status: 'executable' }).success).toBe(false);
        expect(
            ProviderExecutionCapabilitySchema.safeParse({
                status: 'model-discovery-only',
                adapterFamily: 'openai-responses',
            }).success,
        ).toBe(false);
    });

    it('rejects provider catalog entries with malformed model variants', () => {
        const parsed = ProviderCatalogEntrySchema.safeParse({
            id: 'local',
            name: 'Local Sandbox',
            defaultModelID: 'local-echo',
            authLabel: 'API key',
            capability: {
                status: 'executable',
                adapterFamily: 'local',
            },
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

    it('exposes MODEL_ROLE_IDS as the 10 built-in roles in the canonical order', () => {
        expect(MODEL_ROLE_IDS).toEqual([
            'default',
            'smol',
            'slow',
            'vision',
            'plan',
            'designer',
            'commit',
            'title',
            'task',
            'advisor',
        ]);
    });

    it('ModelRoleSchema accepts the built-in roles and rejects unknown roles', () => {
        expect(ModelRoleSchema.safeParse('slow').success).toBe(true);
        expect(ModelRoleSchema.safeParse('default').success).toBe(true);
        expect(ModelRoleSchema.safeParse('task').success).toBe(true);
        expect(ModelRoleSchema.safeParse('bogus').success).toBe(false);
        expect(ModelRoleSchema.safeParse('').success).toBe(false);
    });

    it('ModelRoleAssignmentsSchema accepts a partial record and rejects unknown role keys', () => {
        const partial = ModelRoleAssignmentsSchema.safeParse({
            slow: { providerID: 'a', modelID: 'b' },
        });
        expect(partial.success).toBe(true);

        const rejected = ModelRoleAssignmentsSchema.safeParse({
            bogus: { providerID: 'a', modelID: 'b' },
        });
        expect(rejected.success).toBe(false);
    });

    it('ProviderAuthFileSchema parses a legacy auth file without modelRoles and leaves it undefined', () => {
        const parsed = ProviderAuthFileSchema.parse({
            $schema: 'https://mission-control.local/auth.schema.json',
            credentials: {},
        });
        expect(parsed.modelRoles).toBeUndefined();
        expect(parsed.credentials).toEqual({});
    });

    it('ProviderAuthFileSchema parses an auth file with modelRoles populated', () => {
        const parsed = ProviderAuthFileSchema.parse({
            $schema: 'https://mission-control.local/auth.schema.json',
            credentials: {},
            modelRoles: {
                slow: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
                vision: { providerID: 'openai', modelID: 'gpt-4o', variantID: 'reasoning-high' },
            },
        });
        expect(parsed.modelRoles).toEqual({
            slow: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
            vision: { providerID: 'openai', modelID: 'gpt-4o', variantID: 'reasoning-high' },
        });
    });
});
