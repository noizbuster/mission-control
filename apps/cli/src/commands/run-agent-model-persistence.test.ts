import { missionControlAuthFileEnvKey } from '@mission-control/config';
import { missionControlDataDirEnvKey } from '@mission-control/core';
import { ProviderAuthFileSchema } from '@mission-control/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args.js';
import { createProviderAuthStore } from '../auth-store.js';
import { getCatalogDefaultModelID } from './model-catalog-test-support.js';
import { runAgent } from './run-agent.js';
import { createBufferedChatOutput, createScriptedChatInput } from './run-agent-chat-test-support.js';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tempDirs: string[] = [];

async function useTempAuthFile(): Promise<string> {
    const directory = await useTempDir('mission-control-model-persistence-auth-');
    const authFilePath = join(directory, 'auth.json');
    vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
    return authFilePath;
}

async function useTempDataDir(): Promise<string> {
    const directory = await useTempDir('mission-control-model-persistence-data-');
    vi.stubEnv(missionControlDataDirEnvKey, directory);
    return directory;
}

async function useTempDir(prefix: string): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), prefix));
    tempDirs.push(directory);
    return directory;
}

describe('runAgent /model persistence', () => {
    afterEach(async () => {
        vi.unstubAllEnvs();
        await Promise.all(tempDirs.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
    });

    it('uses a /model selection as the default model on the next chat execution', async () => {
        const authFilePath = await useTempAuthFile();
        await useTempDataDir();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'anthropic',
            modelID: getCatalogDefaultModelID('anthropic'),
            fields: [{ id: 'apiKey', value: 'anthropic_secret_key', secret: true }],
            now: '2026-06-03T10:00:00.000Z',
        });

        await runAgent(parseArgs([]), {
            authStore: store,
            chatInput: createScriptedChatInput([
                { type: 'line', value: '/model anthropic/claude-sonnet-4-6#thinking-high' },
                { type: 'interrupt' },
                { type: 'interrupt' },
            ]),
            chatOutput: createBufferedChatOutput().output,
            modelDiscovery: async () => undefined,
        });
        const laterOutput = await runAgent(parseArgs([]), {
            authStore: createProviderAuthStore(),
            chatInput: createScriptedChatInput([{ type: 'interrupt' }, { type: 'interrupt' }]),
            chatOutput: createBufferedChatOutput().output,
            modelDiscovery: async () => undefined,
        });

        const parsed = ProviderAuthFileSchema.parse(JSON.parse(await readFile(authFilePath, 'utf8')));
        expect(parsed.default).toEqual({
            providerID: 'anthropic',
            modelID: 'claude-sonnet-4-6',
            variantID: 'thinking-high',
        });
        expect(laterOutput).toContain('selection: anthropic/claude-sonnet-4-6#thinking-high');
    });
});
