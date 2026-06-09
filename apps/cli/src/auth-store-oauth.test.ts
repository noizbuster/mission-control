import { missionControlAuthFileEnvKey } from '@mission-control/config';
import { ProviderAuthFileSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderAuthStore } from './auth-store.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function createAuthFilePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-auth-oauth-'));
    return join(directory, 'auth.json');
}

describe('ProviderAuthStore OAuth credentials', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('stores OAuth credentials and redacts tokens from summaries', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        const store = createProviderAuthStore();

        await store.saveCredential({
            providerID: 'openai',
            modelID: 'gpt-5',
            oauth: {
                accessToken: 'openai_access_token',
                refreshToken: 'openai_refresh_token',
                expiresAt: '2026-06-03T11:00:00.000Z',
                scopes: ['openid', 'profile', 'email'],
                accountLabel: 'chatgpt@example.com',
            },
            now: '2026-06-03T10:00:00.000Z',
        });

        const parsed = ProviderAuthFileSchema.parse(JSON.parse(await readFile(authFilePath, 'utf8')));
        expect(parsed.credentials['openai']).toMatchObject({
            providerID: 'openai',
            type: 'oauth',
            accessToken: 'openai_access_token',
            refreshToken: 'openai_refresh_token',
            accountLabel: 'chatgpt@example.com',
        });
        await expect(store.listCredentialSummaries()).resolves.toEqual([
            {
                providerID: 'openai',
                authenticated: true,
                credentialType: 'oauth',
                maskedCredential: 'OAuth (chatgpt@example.com)',
            },
        ]);
        await rm(authFilePath, { force: true });
    });
});
