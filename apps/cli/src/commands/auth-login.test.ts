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
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-auth-command-'));
    const authFilePath = join(directory, 'auth.json');
    vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
    return authFilePath;
}

describe('runAuthCommand auth login', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('logs in provider credentials', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        const login = await runAuthCommand(
            parseArgs(['auth', 'login', '--provider', 'local', '--api-key', 'local_test_key']),
            {
                now: '2026-06-03T10:00:00.000Z',
                store,
            },
        );

        expect(login).toContain('Logged in local');
        expect(login).toContain('default: local/local-echo');
        expect(login).toContain('credential: loca..._key');
        expect(login).not.toContain('local_test_key');
        await rm(authFilePath, { force: true });
    });

    it('rejects unknown providers before writing credentials', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        await expect(
            runAuthCommand(parseArgs(['auth', 'login', '--provider', 'unknown', '--api-key', 'mc_test_key']), {
                now: '2026-06-03T10:00:00.000Z',
                store,
            }),
        ).rejects.toThrow('Unknown provider: unknown');
        await expect(store.listCredentialSummaries()).resolves.toEqual([]);
        await rm(authFilePath, { force: true });
    });

    it('does not prompt for provider when explicit provider flag is supplied', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        const providerPrompts: string[] = [];

        const output = await runAuthCommand(
            parseArgs(['auth', 'login', '--provider', 'local', '--api-key', 'local_test_key']),
            {
                now: '2026-06-03T10:00:00.000Z',
                store,
                promptProvider: async (message) => {
                    providerPrompts.push(message);
                    return 'anthropic';
                },
            },
        );

        expect(output).toContain('Logged in local');
        expect(output).toContain('default: local/local-echo');
        expect(providerPrompts).toEqual([]);
        await rm(authFilePath, { force: true });
    });

    it('logs in OpenCode providers with api key alias as the primary secret field', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        const output = await runAuthCommand(
            parseArgs(['auth', 'login', '--provider', 'anthropic', '--api-key', 'anthropic_secret_key']),
            {
                now: '2026-06-03T10:00:00.000Z',
                store,
            },
        );

        const parsed = ProviderAuthFileSchema.parse(JSON.parse(await readFile(authFilePath, 'utf8')));
        expect(output).toContain('Logged in anthropic');
        expect(output).toContain('credential: anth..._key (1 field)');
        expect(output).not.toContain('anthropic_secret_key');
        expect(parsed.credentials['anthropic']).toMatchObject({
            providerID: 'anthropic',
            type: 'fields',
            fields: {
                apiKey: {
                    value: 'anthropic_secret_key',
                    secret: true,
                },
            },
        });
        await rm(authFilePath, { force: true });
    });

    it('logs in multi-field OpenCode providers without echoing raw secrets', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        const output = await runAuthCommand(
            parseArgs([
                'auth',
                'login',
                '--provider',
                'cloudflare-ai-gateway',
                '--credential',
                'accountId=acct_test',
                '--credential',
                'apiToken=cf_secret_token',
                '--credential',
                'gatewayId=gw_test',
            ]),
            {
                now: '2026-06-03T10:00:00.000Z',
                store,
            },
        );

        const parsed = ProviderAuthFileSchema.parse(JSON.parse(await readFile(authFilePath, 'utf8')));
        expect(output).toContain('Logged in cloudflare-ai-gateway');
        expect(output).toContain('credential: cf_s...oken (3 fields)');
        expect(output).not.toContain('cf_secret_token');
        expect(parsed.credentials['cloudflare-ai-gateway']).toMatchObject({
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
        });
        await rm(authFilePath, { force: true });
    });

    it('uses provider environment variables for missing credential fields', async () => {
        const authFilePath = await useTempAuthFile();
        vi.stubEnv('CLOUDFLARE_GATEWAY_ID', 'gw_env');
        const store = createProviderAuthStore();

        const output = await runAuthCommand(
            parseArgs([
                'auth',
                'login',
                '--provider',
                'cloudflare-ai-gateway',
                '--credential',
                'accountId=acct_test',
                '--credential',
                'apiToken=cf_secret_token',
            ]),
            {
                now: '2026-06-03T10:00:00.000Z',
                store,
            },
        );

        const parsed = ProviderAuthFileSchema.parse(JSON.parse(await readFile(authFilePath, 'utf8')));
        expect(output).toContain('Logged in cloudflare-ai-gateway');
        expect(parsed.credentials['cloudflare-ai-gateway']).toMatchObject({
            fields: {
                gatewayId: {
                    value: 'gw_env',
                    secret: false,
                },
            },
        });
        await rm(authFilePath, { force: true });
    });

    it('rejects missing required multi-field credentials before writing', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        await expect(
            runAuthCommand(
                parseArgs([
                    'auth',
                    'login',
                    '--provider',
                    'cloudflare-ai-gateway',
                    '--credential',
                    'accountId=acct_test',
                    '--credential',
                    'apiToken=cf_secret_token',
                ]),
                {
                    now: '2026-06-03T10:00:00.000Z',
                    store,
                },
            ),
        ).rejects.toThrow('auth login requires credential gatewayId');
        await expect(store.listCredentialSummaries()).resolves.toEqual([]);
        await rm(authFilePath, { force: true });
    });
});
