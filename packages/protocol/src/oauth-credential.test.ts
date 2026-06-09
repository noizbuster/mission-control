import { describe, expect, it } from 'vitest';
import { ProviderAuthFileSchema, ProviderCredentialSchema, ProviderCredentialSummarySchema } from './schema.js';

describe('OAuth provider credential schemas', () => {
    it('parses OAuth credentials and summaries without requiring API-key fields', () => {
        const credential = ProviderCredentialSchema.parse({
            providerID: 'openai',
            type: 'oauth',
            accessToken: 'openai_access_token',
            refreshToken: 'openai_refresh_token',
            expiresAt: '2026-06-03T11:00:00.000Z',
            scopes: ['openid', 'profile', 'email'],
            accountLabel: 'chatgpt@example.com',
            createdAt: '2026-06-03T10:00:00.000Z',
            updatedAt: '2026-06-03T10:00:00.000Z',
        });

        const authFile = ProviderAuthFileSchema.parse({
            $schema: 'https://mission-control.local/auth.schema.json',
            credentials: {
                openai: credential,
            },
        });
        const summary = ProviderCredentialSummarySchema.parse({
            providerID: 'openai',
            authenticated: true,
            credentialType: 'oauth',
            maskedCredential: 'OAuth (chatgpt@example.com)',
        });

        expect(authFile.credentials['openai']).toMatchObject({
            type: 'oauth',
            accessToken: 'openai_access_token',
            refreshToken: 'openai_refresh_token',
        });
        expect(summary).toMatchObject({
            credentialType: 'oauth',
            maskedCredential: 'OAuth (chatgpt@example.com)',
        });
    });
});
