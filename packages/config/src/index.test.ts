import { describe, expect, it } from 'vitest';
import {
    defaultModelProviderSelection,
    missionControlAuthFileEnvKey,
    missionControlAuthSchemaURL,
    modelProviderCatalog,
    opencodeProviderCatalog,
} from './index.js';

describe('config catalog constants', () => {
    it('exports the default local model provider selection and catalog without test providers', () => {
        expect(defaultModelProviderSelection).toEqual({
            providerID: 'local',
            modelID: 'local-echo',
        });
        expect(modelProviderCatalog.map((provider) => provider.id)).toEqual(expect.arrayContaining(['local']));
        expect(modelProviderCatalog.map((provider) => provider.id)).not.toContain('mock');
        const localProvider = modelProviderCatalog.find((provider) => provider.id === 'local');
        expect(localProvider?.models.map((model) => model.id)).toEqual(['local-echo']);
        expect(localProvider?.authLabel).toBe('API key');
        expect(missionControlAuthFileEnvKey).toBe('MISSION_CONTROL_AUTH_FILE');
        expect(missionControlAuthSchemaURL).toBe('https://mission-control.local/auth.schema.json');
    });

    it('exports the vendored OpenCode provider catalog from Models.dev', () => {
        const providerIDs = opencodeProviderCatalog.map((provider) => provider.id);
        const providerIDSet = new Set(providerIDs);

        expect(opencodeProviderCatalog).toHaveLength(140);
        expect(providerIDSet.size).toBe(providerIDs.length);
        expect(providerIDs).toEqual(
            expect.arrayContaining([
                'anthropic',
                'openai',
                'github-copilot',
                'cloudflare-ai-gateway',
                'amazon-bedrock',
            ]),
        );

        for (const provider of opencodeProviderCatalog) {
            expect(provider.name.length).toBeGreaterThan(0);
            expect(provider.authFields.length).toBeGreaterThan(0);
            expect(provider.models.length).toBeGreaterThan(0);
            expect(provider.models.some((model) => model.id === provider.defaultModelID)).toBe(true);
        }
    });

    it('sorts generated providers by opencode auth login priority before provider name', () => {
        expect(opencodeProviderCatalog.slice(0, 7).map((provider) => provider.id)).toEqual([
            'opencode',
            'openai',
            'github-copilot',
            'google',
            'anthropic',
            'openrouter',
            'vercel',
        ]);
    });

    it('exposes opencode-style auth methods for OAuth-capable AI SDK providers', () => {
        const openaiProvider = modelProviderCatalog.find((provider) => provider.id === 'openai');
        const githubCopilotProvider = modelProviderCatalog.find((provider) => provider.id === 'github-copilot');
        const anthropicProvider = modelProviderCatalog.find((provider) => provider.id === 'anthropic');

        expect(openaiProvider?.authMethods.map((method) => method.id)).toEqual([
            'oauth-browser',
            'oauth-headless',
            'api-key',
        ]);
        expect(githubCopilotProvider?.authMethods.map((method) => method.id)).toEqual(['oauth-device', 'api-key']);
        expect(anthropicProvider?.authMethods.map((method) => method.id)).toEqual(['api-key']);
    });

    it('combines local and OpenCode providers without test-only providers', () => {
        const providerIDs = modelProviderCatalog.map((provider) => provider.id);

        expect(providerIDs).toEqual(expect.arrayContaining(['local']));
        expect(providerIDs).not.toContain('mock');
        for (const provider of opencodeProviderCatalog) {
            expect(providerIDs).toContain(provider.id);
        }
        expect(new Set(providerIDs).size).toBe(providerIDs.length);
    });

    it('exports local model variants', () => {
        const localProvider = modelProviderCatalog.find((provider) => provider.id === 'local');
        const localModel = localProvider?.models.find((model) => model.id === 'local-echo');

        expect(localModel?.variants?.map((variant) => variant.id)).toEqual([
            'default',
            'fast',
            'reasoning-low',
            'reasoning-medium',
            'reasoning-high',
            'thinking',
        ]);
    });
});
