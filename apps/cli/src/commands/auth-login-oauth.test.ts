import { missionControlAuthFileEnvKey } from '@mission-control/config';
import { ProviderAuthFileSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { createProviderAuthStore } from '../auth-store.js';
import { runAuthCommand } from './auth.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function useTempAuthFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-auth-login-oauth-'));
    const authFilePath = join(directory, 'auth.json');
    vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
    return authFilePath;
}

describe('runAuthCommand auth login OAuth', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('logs in OAuth-capable providers through the selected auth method', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        const loginCalls: string[] = [];

        const output = await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'openai', '--method', 'oauth']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
            oauthClient: {
                login: async ({ providerID, methodID }) => {
                    loginCalls.push(`${providerID}:${methodID}`);
                    return {
                        accessToken: 'openai_access_token',
                        refreshToken: 'openai_refresh_token',
                        expiresAt: '2026-06-03T11:00:00.000Z',
                        scopes: ['openid', 'profile', 'email'],
                        accountLabel: 'chatgpt@example.com',
                    };
                },
            },
        });

        const parsed = ProviderAuthFileSchema.parse(JSON.parse(await readFile(authFilePath, 'utf8')));
        expect(loginCalls).toEqual(['openai:oauth-browser']);
        expect(output).toContain('Logged in openai');
        expect(output).toContain('credential: OAuth (chatgpt@example.com)');
        expect(output).not.toContain('openai_access_token');
        expect(output).not.toContain('openai_refresh_token');
        expect(parsed.credentials['openai']).toMatchObject({
            providerID: 'openai',
            type: 'oauth',
            accessToken: 'openai_access_token',
            refreshToken: 'openai_refresh_token',
            accountLabel: 'chatgpt@example.com',
        });
        await rm(authFilePath, { force: true });
    });

    it('prompts for auth method when a selected provider supports multiple methods', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        const prompts: string[] = [];
        const loginCalls: string[] = [];

        const output = await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'openai']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
            promptProvider: async (message) => {
                prompts.push(message);
                return 'oauth-headless';
            },
            oauthClient: {
                login: async ({ providerID, methodID }) => {
                    loginCalls.push(`${providerID}:${methodID}`);
                    return {
                        accessToken: 'openai_access_token',
                        refreshToken: 'openai_refresh_token',
                        accountLabel: 'chatgpt@example.com',
                    };
                },
            },
        });

        expect(prompts).toEqual(['Select auth method']);
        expect(loginCalls).toEqual(['openai:oauth-headless']);
        expect(output).toContain('credential: OAuth (chatgpt@example.com)');
        expect(output).not.toContain('openai_access_token');
        await rm(authFilePath, { force: true });
    });

    it('rejects OAuth login for API-key-only providers before writing credentials', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        await expect(
            runAuthCommand(parseArgs(['auth', 'login', '--provider', 'anthropic', '--method', 'oauth']), {
                now: '2026-06-03T10:00:00.000Z',
                store,
            }),
        ).rejects.toThrow('Provider anthropic does not support OAuth login');
        await expect(store.listCredentialSummaries()).resolves.toEqual([]);
        await rm(authFilePath, { force: true });
    });
});
