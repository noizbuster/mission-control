import { missionControlAuthFileEnvKey } from '@mission-control/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { parseArgs } from '../args';
import { createProviderAuthStore } from '../auth-store';
import { resolveModelProviderSelection } from './run-agent-model-selection';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('resolveModelProviderSelection', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('ignores a non-executable auth default so CLI startup falls back to local', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mission-control-model-selection-'));
        const authFilePath = join(directory, 'auth.json');
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'perplexity',
            modelID: 'sonar',
            apiKey: 'pplx_test_key',
            now: '2026-06-03T10:00:00.000Z',
        });

        const selection = await resolveModelProviderSelection(parseArgs([]), store);
        expect(selection).toBeUndefined();
        await rm(directory, { recursive: true, force: true });
    });

    it('keeps an executable auth default', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mission-control-model-selection-'));
        const authFilePath = join(directory, 'auth.json');
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        const store = createProviderAuthStore();
        await store.saveCredential({
            providerID: 'openai',
            modelID: 'gpt-5',
            apiKey: 'sk-test',
            now: '2026-06-03T10:00:00.000Z',
        });

        const selection = await resolveModelProviderSelection(parseArgs([]), store);
        expect(selection).toEqual({ providerID: 'openai', modelID: 'gpt-5' });
        await rm(directory, { recursive: true, force: true });
    });

    it('preserves explicit CLI model selection even when non-executable', async () => {
        const directory = await mkdtemp(join(tmpdir(), 'mission-control-model-selection-'));
        const authFilePath = join(directory, 'auth.json');
        vi.stubEnv(missionControlAuthFileEnvKey, authFilePath);
        const store = createProviderAuthStore();

        const selection = await resolveModelProviderSelection(
            parseArgs(['--model', 'perplexity/sonar']),
            store,
        );
        expect(selection).toEqual({ providerID: 'perplexity', modelID: 'sonar' });
        await rm(directory, { recursive: true, force: true });
    });
});
