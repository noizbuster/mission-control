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

describe('runAuthCommand prompted auth logout', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('logs out a prompted configured provider and displays masked settings', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        const providerPrompts: string[] = [];
        const providerChoices: Array<readonly (readonly [string, string])[]> = [];

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

        const logout = await runAuthCommand(parseArgs(['auth', 'logout']), {
            store,
            promptProvider: async (message, choices) => {
                providerPrompts.push(message);
                providerChoices.push(choices.map((choice) => [choice.id, choice.name] as const));
                return '2';
            },
        });
        const list = await runAuthCommand(parseArgs(['auth', 'list']), { store });

        expect(logout).toBe('Logged out anthropic\n');
        expect(providerPrompts).toEqual(['Select provider to log out']);
        expect(providerChoices).toEqual([
            [
                ['local', 'Local Sandbox - loca..._key'],
                ['anthropic', 'Anthropic - anth..._key (1 field) - default anthropic/claude-3-5-haiku-20241022'],
            ],
        ]);
        expect(list).toContain('local Local Sandbox - loca..._key');
        expect(list).not.toContain('anthropic Anthropic');
        await rm(authFilePath, { force: true });
    });

    it('shows the empty state for prompted logout when no credentials are configured', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        const providerPrompts: string[] = [];

        const logout = await runAuthCommand(parseArgs(['auth', 'logout']), {
            store,
            createPromptSession: () => {
                throw new Error('prompt session should not be created');
            },
        });

        expect(logout).toBe('No provider credentials configured\n');
        expect(providerPrompts).toEqual([]);
        await rm(authFilePath, { force: true });
    });

    it('rejects invalid prompted logout selections without deleting credentials', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        const invalidSelection = 'not_a_configured_secret';

        await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'local', '--api-key', 'local_secret_key']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
        });

        try {
            await runAuthCommand(parseArgs(['auth', 'logout']), {
                store,
                promptProvider: async () => invalidSelection,
            });
            throw new Error('expected auth logout to reject an invalid provider selection');
        } catch (error) {
            if (!(error instanceof Error)) {
                throw error;
            }
            expect(error.message).toBe('Unknown provider selection');
            expect(error.message).not.toContain(invalidSelection);
        }
        await expect(store.listCredentialSummaries()).resolves.toEqual([
            {
                providerID: 'local',
                authenticated: true,
                maskedCredential: 'loca..._key',
            },
        ]);
        await rm(authFilePath, { force: true });
    });
});
