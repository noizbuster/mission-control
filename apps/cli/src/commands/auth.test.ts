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

describe('runAuthCommand', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('logs in lists and logs out provider credentials', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        const login = await runAuthCommand(
            parseArgs(['auth', 'login', '--provider', 'mock', '--api-key', 'mc_test_key']),
            {
                now: '2026-06-03T10:00:00.000Z',
                store,
            },
        );
        const list = await runAuthCommand(parseArgs(['auth', 'list']), { store });
        const logout = await runAuthCommand(parseArgs(['auth', 'logout', '--provider', 'mock']), { store });

        expect(login).toContain('Logged in mock');
        expect(login).toContain('default: mock/mission-control-demo');
        expect(login).toContain('credential: mc_t..._key');
        expect(login).not.toContain('mc_test_key');
        expect(list).toContain('mock');
        expect(list).toContain('mc_t..._key');
        expect(logout).toContain('Logged out mock');
        await expect(store.listCredentialSummaries()).resolves.toEqual([]);
        await rm(authFilePath, { force: true });
    });

    it('logs in interactively when provider and api key are omitted', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        const answers = ['local', 'local_key'];

        const output = await runAuthCommand(parseArgs(['auth', 'login']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
            prompt: async () => answers.shift() ?? '',
        });

        expect(output).toContain('Logged in local');
        expect(output).toContain('default: local/local-echo');
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

    it('rejects unknown providers on logout', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        await expect(runAuthCommand(parseArgs(['auth', 'logout', '--provider', 'unknown']), { store })).rejects.toThrow(
            'Unknown provider: unknown',
        );
        await expect(store.listCredentialSummaries()).resolves.toEqual([]);
        await rm(authFilePath, { force: true });
    });

    it('uses a secret prompt for interactive api keys', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        const prompts: string[] = [];
        const secretPrompts: string[] = [];

        const output = await runAuthCommand(parseArgs(['auth', 'login']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
            prompt: async (message) => {
                prompts.push(message);
                return 'local';
            },
            promptSecret: async (message) => {
                secretPrompts.push(message);
                return 'secret_key';
            },
        });

        expect(output).toContain('Logged in local');
        expect(prompts).toEqual(['provider']);
        expect(secretPrompts).toEqual(['API key']);
        expect(output).not.toContain('secret_key');
        await rm(authFilePath, { force: true });
    });
});
