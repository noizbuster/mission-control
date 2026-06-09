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

    it('lists models with authentication status', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'local',
            modelID: 'local-echo',
            apiKey: 'local_key',
            now: '2026-06-03T10:00:00.000Z',
        });

        const output = await runModelsCommand(parseArgs(['models', 'local']), { store });

        expect(output).toContain('local/local-echo');
        expect(output).toContain('authenticated');
        expect(output).not.toContain('local_key');
        await rm(authFilePath, { force: true });
    });

    it('keeps existing provider model listing baseline before model variants', async () => {
        const output = await runModelsCommand(parseArgs(['models']));

        expect(output).toContain('local/local-echo missing credential');
        expect(output).not.toContain('mock/');
    });

    it('masks credentials when model variants are listed', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'local',
            modelID: 'local-echo',
            apiKey: 'local_super_secret_key',
            now: '2026-06-03T10:00:00.000Z',
        });

        const output = await runModelsCommand(parseArgs(['models', 'local']), { store });

        expect(output).toContain('local/local-echo');
        expect(output).toContain('authenticated');
        expect(output).not.toContain('local_super_secret_key');
        await rm(authFilePath, { force: true });
    });

    it('lists generated OpenCode provider models without requiring credentials', async () => {
        const output = await runModelsCommand(parseArgs(['models', 'anthropic']));

        expect(output).toContain('Models');
        expect(output).toContain('anthropic/claude-3-5-haiku-20241022 missing credential');
        expect(output).not.toContain('mock/');
    });

    it('shows authenticated status for generated provider credentials', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'anthropic',
            modelID: 'claude-3-5-haiku-20241022',
            fields: [{ id: 'apiKey', value: 'anthropic_secret_key', secret: true }],
            now: '2026-06-03T10:00:00.000Z',
        });

        const output = await runModelsCommand(parseArgs(['models', 'anthropic']), { store });

        expect(output).toContain('anthropic/claude-3-5-haiku-20241022 authenticated');
        expect(output).not.toContain('anthropic_secret_key');
        await rm(authFilePath, { force: true });
    });
});
