import { missionControlAuthFileEnvKey, missionControlAuthSchemaURL } from '@mission-control/config';
import { MODEL_ROLE_IDS, type ModelProviderSelection, ProviderAuthFileSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderAuthStore } from './provider-auth-store';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function createAuthFilePath(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-role-auth-'));
    return join(directory, 'auth.json');
}

const SCHEMA_URL = missionControlAuthSchemaURL;

describe('ProviderAuthStore model-role persistence', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('parses a legacy auth file without modelRoles and round-trips without synthesizing the key', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        const legacy = {
            $schema: SCHEMA_URL,
            credentials: {
                local: {
                    providerID: 'local',
                    type: 'apiKey',
                    apiKey: 'legacy_secret_key',
                    createdAt: '2026-06-03T10:00:00.000Z',
                    updatedAt: '2026-06-03T10:00:00.000Z',
                },
            },
        };
        await writeFile(authFilePath, `${JSON.stringify(legacy)}\n`);

        const store = createProviderAuthStore();
        const roles = await store.getModelRoles();
        expect(roles).toEqual({});

        const raw = JSON.parse(await readFile(authFilePath, 'utf8'));
        expect(raw).not.toHaveProperty('modelRoles');
        await rm(authFilePath, { force: true });
    });

    it('returns an empty object from getModelRoles on an empty store', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        const store = createProviderAuthStore();

        await expect(store.getModelRoles()).resolves.toEqual({});
        await rm(authFilePath, { force: true });
    });

    it('setModelRole persists an assignment that getModelRoles reads back', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        const store = createProviderAuthStore();
        const selection: ModelProviderSelection = { providerID: 'a', modelID: 'b' };

        await store.setModelRole('slow', selection);
        await expect(store.getModelRoles()).resolves.toEqual({ slow: selection });

        const parsed = ProviderAuthFileSchema.parse(JSON.parse(await readFile(authFilePath, 'utf8')));
        expect(parsed.modelRoles).toEqual({ slow: selection });
        await rm(authFilePath, { force: true });
    });

    it('updateOAuthCredential refreshes tokens without changing the default selection', async () => {
        // Given
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'xai',
            modelID: 'grok-4.5',
            variantID: 'reasoning-high',
            now: '2026-07-16T08:00:00.000Z',
            oauth: {
                accessToken: 'old-access',
                refreshToken: 'old-refresh',
                expiresAt: '2026-07-16T09:00:00.000Z',
                accountLabel: 'user@example.com',
            },
        });

        // When
        await store.updateOAuthCredential(
            'xai',
            {
                accessToken: 'new-access',
                refreshToken: 'new-refresh',
                expiresAt: '2026-07-16T18:00:00.000Z',
            },
            '2026-07-16T12:00:00.000Z',
        );

        // Then
        const authFile = await store.readAuthFile();
        expect(authFile.default).toEqual({
            providerID: 'xai',
            modelID: 'grok-4.5',
            variantID: 'reasoning-high',
        });
        expect(authFile.credentials['xai']).toMatchObject({
            type: 'oauth',
            accessToken: 'new-access',
            refreshToken: 'new-refresh',
            expiresAt: '2026-07-16T18:00:00.000Z',
            accountLabel: 'user@example.com',
            updatedAt: '2026-07-16T12:00:00.000Z',
        });
        await rm(authFilePath, { force: true });
    });

    it('clearModelRole removes an assignment and leaves an empty map', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        const store = createProviderAuthStore();
        const selection: ModelProviderSelection = { providerID: 'a', modelID: 'b' };

        await store.setModelRole('slow', selection);
        await store.clearModelRole('slow');
        await expect(store.getModelRoles()).resolves.toEqual({});
        await rm(authFilePath, { force: true });
    });

    it('preserves credentials and default across setModelRole and clearModelRole writes', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        const store = createProviderAuthStore();

        await store.saveCredential({
            providerID: 'local',
            modelID: 'local-echo',
            apiKey: 'local_test_key',
            now: '2026-06-03T10:00:00.000Z',
        });

        await store.setModelRole('slow', { providerID: 'a', modelID: 'b' });
        await store.clearModelRole('slow');

        const defaultSelection = await store.getDefaultSelection();
        expect(defaultSelection).toEqual({ providerID: 'local', modelID: 'local-echo' });

        const summaries = await store.listCredentialSummaries();
        expect(summaries).toEqual([{ providerID: 'local', authenticated: true, maskedCredential: 'loca..._key' }]);

        await expect(store.getModelRoles()).resolves.toEqual({});
        await rm(authFilePath, { force: true });
    });

    it('honors the MODEL_ROLE_IDS ordering contract', () => {
        expect(MODEL_ROLE_IDS).toHaveLength(10);
        expect(MODEL_ROLE_IDS).toEqual([
            'default',
            'smol',
            'slow',
            'vision',
            'plan',
            'designer',
            'commit',
            'title',
            'task',
            'advisor',
        ]);
    });
});

describe('ProviderAuthStore concurrency', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('serializes concurrent setModelRole without dropping roles', async () => {
        const authFilePath = await createAuthFilePath();
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        await writeFile(
            authFilePath,
            JSON.stringify({ $schema: SCHEMA_URL, credentials: {}, version: 1 }),
            'utf8',
        );
        const store = createProviderAuthStore();
        const selection = (providerID: string, modelID: string): ModelProviderSelection => ({
            providerID,
            modelID,
        });
        await Promise.all([
            store.setModelRole('smol', selection('openai', 'gpt-smol')),
            store.setModelRole('slow', selection('openai', 'gpt-slow')),
            store.setModelRole('plan', selection('openai', 'gpt-plan')),
        ]);
        const roles = await store.getModelRoles();
        expect(roles.smol?.modelID).toBe('gpt-smol');
        expect(roles.slow?.modelID).toBe('gpt-slow');
        expect(roles.plan?.modelID).toBe('gpt-plan');
        await rm(authFilePath, { force: true });
    });
});
