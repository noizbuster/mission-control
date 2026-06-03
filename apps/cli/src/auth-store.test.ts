import { missionControlAuthFileEnvKey } from '@mission-control/config';
import { ProviderAuthFileSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderAuthStore } from './auth-store.js';
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function createAuthFilePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-auth-'));
    return join(directory, 'auth.json');
}

describe('ProviderAuthStore', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('writes reads masks and deletes provider credentials', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        const store = createProviderAuthStore();

        await store.saveCredential({
            providerID: 'mock',
            modelID: 'mission-control-demo',
            apiKey: 'mc_test_key',
            now: '2026-06-03T10:00:00.000Z',
        });

        const parsed = ProviderAuthFileSchema.parse(JSON.parse(await readFile(authFilePath, 'utf8')));
        expect(parsed.default).toEqual({
            providerID: 'mock',
            modelID: 'mission-control-demo',
        });
        expect(parsed.credentials['mock']?.apiKey).toBe('mc_test_key');
        await expect(store.listCredentialSummaries()).resolves.toEqual([
            {
                providerID: 'mock',
                authenticated: true,
                maskedCredential: 'mc_t..._key',
            },
        ]);
        await expect(store.getDefaultSelection()).resolves.toEqual({
            providerID: 'mock',
            modelID: 'mission-control-demo',
        });

        await store.deleteCredential('mock');

        await expect(store.listCredentialSummaries()).resolves.toEqual([]);
        await expect(store.getDefaultSelection()).resolves.toBeUndefined();
        await rm(authFilePath, { force: true });
    });

    it('uses MISSION_CONTROL_AUTH_FILE override for QA', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);

        expect(createProviderAuthStore().authFilePath).toBe(authFilePath);
        await rm(authFilePath, { force: true });
    });

    it('tightens existing auth files to user-readable permissions only', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        await writeFile(
            authFilePath,
            JSON.stringify({ $schema: 'https://mission-control.local/auth.schema.json', credentials: {} }),
        );
        await chmod(authFilePath, 0o644);
        const store = createProviderAuthStore();

        await store.saveCredential({
            providerID: 'mock',
            modelID: 'mission-control-demo',
            apiKey: 'mc_test_key',
            now: '2026-06-03T10:00:00.000Z',
        });

        expect((await stat(authFilePath)).mode & 0o777).toBe(0o600);
        await rm(authFilePath, { force: true });
    });
});
