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

describe('runAuthCommand auth prompts', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('logs in interactively when provider and api key are omitted', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        const providerPrompts: string[] = [];
        const providerChoices: Array<readonly (readonly [string, string])[]> = [];

        const output = await runAuthCommand(parseArgs(['auth', 'login']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
            promptProvider: async (message, choices) => {
                providerPrompts.push(message);
                providerChoices.push(choices.map((choice) => [choice.id, choice.name] as const));
                return '1';
            },
            promptSecret: async () => 'local_key',
        });

        expect(output).toContain('Logged in local');
        expect(output).toContain('default: local/local-echo');
        expect(providerPrompts).toEqual(['Select provider']);
        const choices = providerChoices[0];
        expect(choices?.slice(0, 2)).toEqual([
            ['local', 'Local Sandbox'],
            ['opencode', 'OpenCode Zen'],
        ]);
        expect(choices?.slice(1, 7)).toEqual([
            ['opencode', 'OpenCode Zen'],
            ['openai', 'OpenAI'],
            ['github-copilot', 'GitHub Copilot'],
            ['google', 'Google'],
            ['anthropic', 'Anthropic'],
            ['openrouter', 'OpenRouter'],
        ]);
        expect(choices).toContainEqual(['anthropic', 'Anthropic']);
        expect(choices).toContainEqual(['cloudflare-ai-gateway', 'Cloudflare AI Gateway']);
        await rm(authFilePath, { force: true });
    });

    it('rejects empty interactive provider selections before writing credentials', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();

        await expect(
            runAuthCommand(parseArgs(['auth', 'login']), {
                now: '2026-06-03T10:00:00.000Z',
                store,
                promptProvider: async () => '',
                promptSecret: async () => 'local_key',
            }),
        ).rejects.toThrow('auth login requires --provider');
        await expect(store.listCredentialSummaries()).resolves.toEqual([]);
        await rm(authFilePath, { force: true });
    });

    it('does not echo invalid interactive provider selections in errors', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        const accidentalSecret = 'accidental_secret_key';

        try {
            await runAuthCommand(parseArgs(['auth', 'login']), {
                now: '2026-06-03T10:00:00.000Z',
                store,
                promptProvider: async () => accidentalSecret,
                promptSecret: async () => 'local_key',
            });
            throw new Error('expected auth login to reject an invalid provider selection');
        } catch (error) {
            if (!(error instanceof Error)) {
                throw error;
            }
            expect(error.message).toBe('Unknown provider selection');
            expect(error.message).not.toContain(accidentalSecret);
        }
        await expect(store.listCredentialSummaries()).resolves.toEqual([]);
        await rm(authFilePath, { force: true });
    });

    it('keeps the generic prompt fallback for provider and api key prompts', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        const prompts: string[] = [];
        const answers = ['1', 'generic_key'];

        const output = await runAuthCommand(parseArgs(['auth', 'login']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
            prompt: async (message) => {
                prompts.push(message);
                return answers.shift() ?? '';
            },
        });

        expect(output).toContain('Logged in local');
        expect(output).toContain('default: local/local-echo');
        expect(output).not.toContain('generic_key');
        expect(prompts).toEqual(['Select provider', 'API key']);
        await rm(authFilePath, { force: true });
    });

    it('uses a secret prompt for interactive api keys', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        const providerPrompts: string[] = [];
        const secretPrompts: string[] = [];

        const output = await runAuthCommand(parseArgs(['auth', 'login']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
            promptProvider: async (message) => {
                providerPrompts.push(message);
                return 'local';
            },
            promptSecret: async (message) => {
                secretPrompts.push(message);
                return 'secret_key';
            },
        });

        expect(output).toContain('Logged in local');
        expect(providerPrompts).toEqual(['Select provider']);
        expect(secretPrompts).toEqual(['API key']);
        expect(output).not.toContain('secret_key');
        await rm(authFilePath, { force: true });
    });

    it('prompts text credential fields visibly and secret credential fields with the secret prompt', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        const textPrompts: string[] = [];
        const secretPrompts: string[] = [];

        const output = await runAuthCommand(parseArgs(['auth', 'login', '--provider', 'cloudflare-ai-gateway']), {
            now: '2026-06-03T10:00:00.000Z',
            store,
            prompt: async (message) => {
                textPrompts.push(message);
                if (message === 'Cloudflare account ID') {
                    return 'acct_prompt';
                }
                if (message === 'Cloudflare gateway ID') {
                    return 'gw_prompt';
                }
                return '';
            },
            promptSecret: async (message) => {
                secretPrompts.push(message);
                return 'cf_secret_prompt';
            },
        });

        expect(output).toContain('Logged in cloudflare-ai-gateway');
        expect(output).toContain('credential: cf_s...ompt (3 fields)');
        expect(output).not.toContain('cf_secret_prompt');
        expect(textPrompts).toEqual(['Cloudflare account ID', 'Cloudflare gateway ID']);
        expect(secretPrompts).toEqual(['Cloudflare API token']);
        await rm(authFilePath, { force: true });
    });
});
