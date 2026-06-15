import { missionControlAuthFileEnvKey } from '@mission-control/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { createProviderAuthStore } from '../auth-store.js';
import { runModelsCommand } from './models.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function useTempAuthFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-models-command-'));
    const authFilePath = join(directory, 'auth.json');
    vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
    return authFilePath;
}

describe('runModelsCommand', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('lists models from catalog when authenticated without discovery', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'local',
            modelID: 'local-echo',
            apiKey: 'local_key',
            now: '2026-06-03T10:00:00.000Z',
        });

        const output = await runModelsCommand(parseArgs(['models', 'local']), {
            store,
            modelDiscovery: async () => undefined,
        });

        expect(output).toContain('local/local-echo');
        expect(output).not.toContain('local_key');
        await rm(authFilePath, { force: true });
    });

    it('shows only authenticated providers when no provider specified', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'local',
            modelID: 'local-echo',
            apiKey: 'local_key',
            now: '2026-06-03T10:00:00.000Z',
        });

        const output = await runModelsCommand(parseArgs(['models']), {
            store,
            modelDiscovery: async () => undefined,
        });

        expect(output).toContain('local/local-echo');
        expect(output).not.toContain('anthropic/');
        expect(output).not.toContain('opencode/');
        await rm(authFilePath, { force: true });
    });

    it('hides executable status suffix and shows non-executable in parentheses', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'perplexity',
            modelID: 'sonar',
            fields: [{ id: 'apiKey', value: 'perplexity_secret_key', secret: true }],
            now: '2026-06-03T10:00:00.000Z',
        });

        const output = await runModelsCommand(parseArgs(['models', 'perplexity']), {
            store,
            modelDiscovery: async () => undefined,
        });

        expect(output).toContain('perplexity/sonar');
        expect(output).toContain('model-discovery-only');
        expect(output).not.toContain('perplexity_secret_key');
        await rm(authFilePath, { force: true });
    });

    it('prefers API model list when discovery succeeds', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'anthropic',
            modelID: 'claude-3-5-haiku-20241022',
            fields: [{ id: 'apiKey', value: 'anthropic_secret_key', secret: true }],
            now: '2026-06-03T10:00:00.000Z',
        });

        const output = await runModelsCommand(parseArgs(['models', 'anthropic']), {
            store,
            modelDiscovery: async () => ['claude-3-5-haiku-20241022', 'claude-opus-4-8'],
        });

        expect(output).toContain('anthropic/claude-3-5-haiku-20241022');
        expect(output).toContain('anthropic/claude-opus-4-8');
        expect(output).not.toContain('anthropic_secret_key');
        await rm(authFilePath, { force: true });
    });

    it('marks catalog-only models when discovery provides a different set', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'anthropic',
            modelID: 'claude-3-5-haiku-20241022',
            fields: [{ id: 'apiKey', value: 'anthropic_secret_key', secret: true }],
            now: '2026-06-03T10:00:00.000Z',
        });

        const output = await runModelsCommand(parseArgs(['models', 'anthropic']), {
            store,
            modelDiscovery: async () => ['claude-3-5-haiku-20241022'],
        });

        expect(output).toContain('anthropic/claude-3-5-haiku-20241022');
        const catalogOnlyModels = output.split('\n').filter((line) => line.includes('(catalog only)'));
        expect(catalogOnlyModels.length).toBeGreaterThan(0);
        expect(catalogOnlyModels.every((line) => !line.includes('claude-3-5-haiku-20241022'))).toBe(true);
        await rm(authFilePath, { force: true });
    });

    it('does not leak credentials in output', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'local',
            modelID: 'local-echo',
            apiKey: 'local_super_secret_key',
            now: '2026-06-03T10:00:00.000Z',
        });

        const output = await runModelsCommand(parseArgs(['models', 'local']), {
            store,
            modelDiscovery: async () => undefined,
        });

        expect(output).not.toContain('local_super_secret_key');
        await rm(authFilePath, { force: true });
    });
});
