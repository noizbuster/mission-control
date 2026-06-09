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
            providerID: 'local',
            modelID: 'local-echo',
            apiKey: 'local_test_key',
            now: '2026-06-03T10:00:00.000Z',
        });

        const parsed = ProviderAuthFileSchema.parse(JSON.parse(await readFile(authFilePath, 'utf8')));
        expect(parsed.default).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
        expect(parsed.credentials['local']).toMatchObject({
            apiKey: 'local_test_key',
        });
        await expect(store.listCredentialSummaries()).resolves.toEqual([
            {
                providerID: 'local',
                authenticated: true,
                maskedCredential: 'loca..._key',
            },
        ]);
        await expect(store.getDefaultSelection()).resolves.toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });

        await store.deleteCredential('local');

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

    it('initializes an existing empty override auth file', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        await writeFile(authFilePath, '');
        const store = createProviderAuthStore();

        await store.saveCredential({
            providerID: 'local',
            modelID: 'local-echo',
            apiKey: 'local_test_key',
            now: '2026-06-03T10:00:00.000Z',
        });

        const parsed = ProviderAuthFileSchema.parse(JSON.parse(await readFile(authFilePath, 'utf8')));
        expect(parsed.credentials['local']).toMatchObject({
            apiKey: 'local_test_key',
        });
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
            providerID: 'local',
            modelID: 'local-echo',
            apiKey: 'local_test_key',
            now: '2026-06-03T10:00:00.000Z',
        });

        expect((await stat(authFilePath)).mode & 0o777).toBe(0o600);
        await rm(authFilePath, { force: true });
    });

    it('tightens existing auth files when reading credentials', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        await writeFile(
            authFilePath,
            `${JSON.stringify({
                $schema: 'https://mission-control.local/auth.schema.json',
                credentials: {
                    local: {
                        providerID: 'local',
                        type: 'apiKey',
                        apiKey: 'local_test_key',
                        createdAt: '2026-06-03T10:00:00.000Z',
                        updatedAt: '2026-06-03T10:00:00.000Z',
                    },
                },
            })}\n`,
        );
        await chmod(authFilePath, 0o644);
        const store = createProviderAuthStore();

        await expect(store.listCredentialSummaries()).resolves.toEqual([
            {
                providerID: 'local',
                authenticated: true,
                maskedCredential: 'loca..._key',
            },
        ]);
        expect((await stat(authFilePath)).mode & 0o777).toBe(0o600);
        await rm(authFilePath, { force: true });
    });

    it('stores multi-field credentials with redacted summaries and preserves other credentials on delete', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        const store = createProviderAuthStore();

        await store.saveCredential({
            providerID: 'local',
            modelID: 'local-echo',
            apiKey: 'local_test_key',
            now: '2026-06-03T10:00:00.000Z',
        });
        await store.saveCredential({
            providerID: 'cloudflare-ai-gateway',
            modelID: '@cf/meta/llama-3.1-8b-instruct',
            fields: [
                { id: 'accountId', value: 'acct_test', secret: false },
                { id: 'apiToken', value: 'cf_secret_token', secret: true },
                { id: 'gatewayId', value: 'gw_test', secret: false },
            ],
            now: '2026-06-03T10:05:00.000Z',
        });

        const parsed = ProviderAuthFileSchema.parse(JSON.parse(await readFile(authFilePath, 'utf8')));
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
        await expect(store.listCredentialSummaries()).resolves.toEqual([
            {
                providerID: 'local',
                authenticated: true,
                maskedCredential: 'loca..._key',
            },
            {
                providerID: 'cloudflare-ai-gateway',
                authenticated: true,
                maskedCredential: 'cf_s...oken (3 fields)',
                credentialFieldCount: 3,
            },
        ]);

        await store.deleteCredential('cloudflare-ai-gateway');

        await expect(store.listCredentialSummaries()).resolves.toEqual([
            {
                providerID: 'local',
                authenticated: true,
                maskedCredential: 'loca..._key',
            },
        ]);
        await rm(authFilePath, { force: true });
    });

    it('reads legacy api key auth files without rewriting them', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        await writeFile(
            authFilePath,
            `${JSON.stringify({
                $schema: 'https://mission-control.local/auth.schema.json',
                credentials: {
                    local: {
                        providerID: 'local',
                        type: 'apiKey',
                        apiKey: 'legacy_secret_key',
                        createdAt: '2026-06-03T10:00:00.000Z',
                        updatedAt: '2026-06-03T10:00:00.000Z',
                    },
                },
            })}\n`,
        );
        const store = createProviderAuthStore();

        await expect(store.listCredentialSummaries()).resolves.toEqual([
            {
                providerID: 'local',
                authenticated: true,
                maskedCredential: 'lega..._key',
            },
        ]);
        await expect(readFile(authFilePath, 'utf8')).resolves.toContain('"type":"apiKey"');
        await rm(authFilePath, { force: true });
    });
});
