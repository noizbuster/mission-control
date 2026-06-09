import { missionControlAuthFileEnvKey } from '@mission-control/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { createProviderAuthStore } from '../auth-store.js';
import { runAuthCommand } from './auth.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function useTempAuthFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-auth-list-oauth-'));
    const authFilePath = join(directory, 'auth.json');
    vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
    return authFilePath;
}

describe('runAuthCommand auth list/logout OAuth credentials', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('lists and logs out OAuth credentials without exposing tokens', async () => {
        const authFilePath = await useTempAuthFile();
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

        const listOutput = await runAuthCommand(parseArgs(['auth', 'list']), { store });
        const logoutOutput = await runAuthCommand(parseArgs(['auth', 'logout', '--provider', 'openai']), { store });

        expect(listOutput).toContain('openai OpenAI - OAuth (chatgpt@example.com) - default openai/gpt-5');
        expect(listOutput).not.toContain('openai_access_token');
        expect(listOutput).not.toContain('openai_refresh_token');
        expect(logoutOutput).toBe('Logged out openai\n');
        await expect(store.listCredentialSummaries()).resolves.toEqual([]);
        await rm(authFilePath, { force: true });
    });
});
