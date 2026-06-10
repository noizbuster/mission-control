import { missionControlAuthFileEnvKey } from '@mission-control/config';
import { ProviderAuthFileSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderAuthStore } from './auth-store.js';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function createAuthFilePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-default-selection-'));
    return join(directory, 'auth.json');
}

describe('ProviderAuthStore default model selection', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('persists a selected model variant without rewriting stored credentials', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        const store = createProviderAuthStore();

        await store.saveCredential({
            providerID: 'anthropic',
            modelID: 'claude-3-5-haiku-20241022',
            fields: [{ id: 'apiKey', value: 'anthropic_secret_key', secret: true }],
            now: '2026-06-03T10:00:00.000Z',
        });
        await store.setDefaultSelection({
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
            variantID: 'thinking',
        });

        const parsed = ProviderAuthFileSchema.parse(JSON.parse(await readFile(authFilePath, 'utf8')));
        expect(parsed.default).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
            variantID: 'thinking',
        });
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
        expect((await stat(authFilePath)).mode & 0o777).toBe(0o600);
        await rm(authFilePath, { force: true });
    });
});
