import { missionControlAuthFileEnvKey } from '@mission-control/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createProviderAuthStore } from '../auth-store.js';
import { runAgent } from './run-agent.js';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function useTempAuthFile(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'mission-control-run-agent-auth-'));
    const authFilePath = join(directory, 'auth.json');
    vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
    return authFilePath;
}

describe('runAgent plain reporter', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('plain reporter prints stable mission-control summary', async () => {
        const output = await runAgent({
            mode: 'plain',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
        });

        expect(output).toContain('mission-control');
        expect(output).toContain('mctrl');
        expect(output).toContain('session_');
        expect(output).toContain('task.completed');
        expect(output).toContain('completed by mock sidecar');
    });

    it('plain reporter prints the selected provider and model', async () => {
        const output = await runAgent({
            mode: 'plain',
            useNative: false,
            command: 'run',
            showHelp: false,
            showVersion: false,
            modelProviderSelection: {
                providerID: 'local',
                modelID: 'local-echo',
            },
        });

        expect(output).toContain('model: local/local-echo');
    });

    it('rejects unknown provider model combinations before running', async () => {
        await expect(
            runAgent({
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                modelProviderSelection: {
                    providerID: 'local',
                    modelID: 'mission-control-demo',
                },
            }),
        ).rejects.toThrow('Model mission-control-demo is not available for provider local');

        await expect(
            runAgent({
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
                modelProviderSelection: {
                    providerID: 'unknown',
                    modelID: 'mission-control-demo',
                },
            }),
        ).rejects.toThrow('Unknown provider: unknown');
    });

    it('uses configured default model when no provider flags are passed', async () => {
        const authFilePath = await useTempAuthFile();
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'local',
            modelID: 'local-echo',
            apiKey: 'local_key',
            now: '2026-06-03T10:00:00.000Z',
        });

        const output = await runAgent(
            {
                mode: 'plain',
                useNative: false,
                command: 'run',
                showHelp: false,
                showVersion: false,
            },
            { authStore: store },
        );

        expect(output).toContain('model: local/local-echo');
        await rm(authFilePath, { force: true });
    });
});
