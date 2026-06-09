import { missionControlAuthFileEnvKey } from '@mission-control/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { createProviderAuthStore } from '../auth-store.js';
import { runAuthCommand } from './auth.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function useTempAuthFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-auth-command-'));
    const authFilePath = join(directory, 'auth.json');
    vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
    return authFilePath;
}

describe('runAuthCommand auth list and logout', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('lists and logs out provider credentials', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'local', '--api-key', 'local_test_key']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
        });
        const list = await runAuthCommand(parseArgs(['auth', 'list']), { store });
        const logout = await runAuthCommand(parseArgs(['auth', 'logout', '--provider', 'local']), { store });

        expect(list).toContain('local Local Sandbox - loca..._key - default local/local-echo');
        expect(logout).toContain('Logged out local');
        await expect(store.listCredentialSummaries()).resolves.toEqual([]);
        await rm(authFilePath, { force: true });
    });

    it('lists provider display names and default selection when providers are configured', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'local', '--api-key', 'local_secret_key']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
        });
        await runAuthCommand(
            parseArgs(['auth', 'login', '--provider', 'anthropic', '--api-key', 'anthropic_secret_key']),
            {
                now: '2026-06-03T10:01:00.000Z',
                store,
            },
        );

        const output = await runAuthCommand(parseArgs(['auth', 'list']), { store });

        const localLine = 'local Local Sandbox - loca..._key';
        const anthropicLine =
            'anthropic Anthropic - anth..._key (1 field) - default anthropic/claude-3-5-haiku-20241022';
        expect(output).toContain('Authenticated providers');
        expect(output.indexOf(localLine)).toBeLessThan(output.indexOf(anthropicLine));
        expect(output).toContain(anthropicLine);
        expect(output).not.toContain('local_secret_key');
        expect(output).not.toContain('anthropic_secret_key');
        await rm(authFilePath, { force: true });
    });

    it('lists the empty state when only stale non-catalog credentials exist', async () => {
        const output = await runAuthCommand(parseArgs(['auth', 'list']), {
            store: {
                authFilePath: '/tmp/stale-auth.json',
                readAuthFile: async () => ({
                    $schema: 'https://mission-control.local/auth.schema.json',
                    credentials: {},
                }),
                saveCredential: async () => {},
                deleteCredential: async () => {},
                listCredentialSummaries: async () => [
                    {
                        providerID: 'removed-provider',
                        authenticated: true,
                        maskedCredential: 'remo...ider',
                    },
                ],
                getDefaultSelection: async () => undefined,
            },
        });

        expect(output).toBe('No provider credentials configured\n');
    });

    it('logs out one provider while preserving other credentials and clearing the removed default', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'local', '--api-key', 'local_secret_key']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
        });
        await runAuthCommand(
            parseArgs(['auth', 'login', '--provider', 'anthropic', '--api-key', 'anthropic_secret_key']),
            {
                now: '2026-06-03T10:01:00.000Z',
                store,
            },
        );

        const logout = await runAuthCommand(parseArgs(['auth', 'logout', '--provider', 'anthropic']), { store });
        const list = await runAuthCommand(parseArgs(['auth', 'list']), { store });

        expect(logout).toContain('Logged out anthropic');
        expect(list).toContain('Authenticated providers');
        expect(list).toContain('local Local Sandbox - loca..._key');
        expect(list).not.toContain('anthropic Anthropic');
        await expect(store.getDefaultSelection()).resolves.toBeUndefined();
        await rm(authFilePath, { force: true });
    });

    it('rejects unknown providers on logout', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        await expect(runAuthCommand(parseArgs(['auth', 'logout', '--provider', 'unknown']), { store })).rejects.toThrow(
            'Unknown provider: unknown',
        );
        await expect(store.listCredentialSummaries()).resolves.toEqual([]);
        await rm(authFilePath, { force: true });
    });

    it('rejects logout for configured providers without credentials and preserves stored credentials', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'anthropic', '--api-key', 'anthropic_key']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
        });

        await expect(runAuthCommand(parseArgs(['auth', 'logout', '--provider', 'local']), { store })).rejects.toThrow(
            'Provider credential not configured: local',
        );
        await expect(store.listCredentialSummaries()).resolves.toEqual([
            {
                providerID: 'anthropic',
                authenticated: true,
                maskedCredential: 'anth..._key (1 field)',
                credentialFieldCount: 1,
            },
        ]);
        await rm(authFilePath, { force: true });
    });

    it('lists configured OpenCode providers in catalog order with masked field summaries', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'cloudflare-ai-gateway']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
            prompt: async (message) => {
                if (message === 'Cloudflare account ID') {
                    return 'acct_test';
                }
                if (message === 'Cloudflare gateway ID') {
                    return 'gw_test';
                }
                return '';
            },
            promptSecret: async () => 'cf_secret_token',
        });
        await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'anthropic', '--api-key', 'anthropic_key']), {
            now: '2026-06-03T10:01:00.000Z',
            store,
        });

        const output = await runAuthCommand(parseArgs(['auth', 'list']), { store });

        expect(output).toContain('Authenticated providers');
        expect(
            output.indexOf('anthropic Anthropic - anth..._key (1 field) - default anthropic/claude-3-5-haiku-20241022'),
        ).toBeLessThan(output.indexOf('cloudflare-ai-gateway Cloudflare AI Gateway - cf_s...oken (3 fields)'));
        expect(output).not.toContain('anthropic_key');
        expect(output).not.toContain('cf_secret_token');
        await rm(authFilePath, { force: true });
    });

    it('logs out one OpenCode provider while preserving another multi-field credential', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'anthropic', '--api-key', 'anthropic_key']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
        });
        await runAuthCommand(
            parseArgs([
                'auth',
                'login',
                '--provider',
                'cloudflare-ai-gateway',
                '--credential',
                'apiToken=cf_secret_token',
                '--credential',
                'accountId=acct_test',
                '--credential',
                'gatewayId=gw_test',
            ]),
            {
                now: '2026-06-03T10:01:00.000Z',
                store,
            },
        );

        const logout = await runAuthCommand(parseArgs(['auth', 'logout', '--provider', 'anthropic']), { store });
        const list = await runAuthCommand(parseArgs(['auth', 'list']), { store });

        expect(logout).toBe('Logged out anthropic\n');
        expect(list).not.toContain('anthropic Anthropic');
        expect(list).not.toContain('anthropic_key');
        expect(list).toContain(
            'cloudflare-ai-gateway Cloudflare AI Gateway - cf_s...oken (3 fields) - default cloudflare-ai-gateway/anthropic/claude-3-5-haiku',
        );
        await expect(store.listCredentialSummaries()).resolves.toEqual([
            {
                providerID: 'cloudflare-ai-gateway',
                authenticated: true,
                maskedCredential: 'cf_s...oken (3 fields)',
                credentialFieldCount: 3,
            },
        ]);
        await rm(authFilePath, { force: true });
    });

    it('rejects logout for known OpenCode providers that are not configured', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        await expect(runAuthCommand(parseArgs(['auth', 'logout', '--provider', 'openai']), { store })).rejects.toThrow(
            'Provider credential not configured: openai',
        );
        await expect(store.listCredentialSummaries()).resolves.toEqual([]);
        await rm(authFilePath, { force: true });
    });
});
