import { ProviderCatalogEntrySchema } from '@mission-control/protocol';
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

    it('exports provider-specific model variants for reasoning and thinking capable providers', () => {
        const openAIProvider = modelProviderCatalog.find((provider) => provider.id === 'openai');
        const openAIReasoningModel = openAIProvider?.models.find((model) => model.id === 'gpt-5');
        const openAILatestReasoningModel = openAIProvider?.models.find((model) => model.id === 'gpt-5.5');
        const openAINonReasoningModel = openAIProvider?.models.find((model) => model.id === 'gpt-4o-mini');
        const anthropicProvider = modelProviderCatalog.find((provider) => provider.id === 'anthropic');
        const anthropicThinkingModel = anthropicProvider?.models.find((model) => model.id === 'claude-sonnet-4-6');

        expect(openAIReasoningModel?.variants?.map((variant) => variant.id)).toEqual([
            'reasoning-minimal',
            'reasoning-low',
            'reasoning-medium',
            'reasoning-high',
        ]);
        expect(openAILatestReasoningModel?.variants?.map((variant) => variant.id)).toEqual([
            'reasoning-none',
            'reasoning-low',
            'reasoning-medium',
            'reasoning-high',
            'reasoning-xhigh',
        ]);
        expect(openAINonReasoningModel?.variants).toBeUndefined();
        expect(anthropicThinkingModel?.variants?.map((variant) => variant.id)).toEqual([
            'thinking-off',
            'thinking-low',
            'thinking-medium',
            'thinking-high',
        ]);
    });

    it('classifies provider execution capability explicitly', () => {
        const localProvider = modelProviderCatalog.find((provider) => provider.id === 'local');
        const openAIProvider = opencodeProviderCatalog.find((provider) => provider.id === 'openai');
        const anthropicProvider = opencodeProviderCatalog.find((provider) => provider.id === 'anthropic');
        const googleProvider = opencodeProviderCatalog.find((provider) => provider.id === 'google');
        const openRouterProvider = opencodeProviderCatalog.find((provider) => provider.id === 'openrouter');
        const groqProvider = opencodeProviderCatalog.find((provider) => provider.id === 'groq');
        const deepSeekProvider = opencodeProviderCatalog.find((provider) => provider.id === 'deepseek');
        const mistralProvider = opencodeProviderCatalog.find((provider) => provider.id === 'mistral');
        const cloudflareProvider = opencodeProviderCatalog.find((provider) => provider.id === 'cloudflare-ai-gateway');
        const githubCopilotProvider = opencodeProviderCatalog.find((provider) => provider.id === 'github-copilot');

        expect(localProvider?.capability).toEqual({
            status: 'executable',
            adapterFamily: 'local',
        });
        expect(openAIProvider?.capability).toEqual({
            status: 'executable',
            adapterFamily: 'openai-responses',
        });
        expect(anthropicProvider?.capability).toEqual({
            status: 'executable',
            adapterFamily: 'anthropic-messages',
        });
        expect(googleProvider?.capability).toEqual({
            status: 'executable',
            adapterFamily: 'google-gemini',
        });
        for (const provider of [openRouterProvider, groqProvider, deepSeekProvider, mistralProvider]) {
            expect(provider?.capability).toEqual({
                status: 'executable',
                adapterFamily: 'openai-compatible',
            });
        }
        expect(cloudflareProvider?.authFields.length).toBeGreaterThan(1);
        expect(cloudflareProvider?.capability).toEqual({
            status: 'model-discovery-only',
        });
        expect(githubCopilotProvider?.capability).toEqual({
            status: 'auth-only',
        });

        const capabilityCounts = capabilityStatusCounts(opencodeProviderCatalog);
        expect(capabilityCounts.executable).toBe(8);
        expect(capabilityCounts['auth-only']).toBe(1);
        expect(capabilityCounts['model-discovery-only']).toBe(131);
        expect(capabilityCounts.unsupported).toBe(0);
        expect(opencodeProviderCatalog.every((provider) => provider.capability.status.length > 0)).toBe(true);
    });

    it('rejects provider catalog entries without explicit capability metadata', () => {
        const parsed = ProviderCatalogEntrySchema.safeParse({
            id: 'fixture',
            name: 'Fixture',
            defaultModelID: 'fixture-model',
            authLabel: 'API key',
            models: [
                {
                    id: 'fixture-model',
                    name: 'Fixture Model',
                    status: 'active',
                },
            ],
        });

        expect(parsed.success).toBe(false);
    });
});

type CapabilityStatusCounts = {
    executable: number;
    'model-discovery-only': number;
    'auth-only': number;
    unsupported: number;
};

function capabilityStatusCounts(providers: typeof opencodeProviderCatalog): CapabilityStatusCounts {
    const counts: CapabilityStatusCounts = {
        executable: 0,
        'model-discovery-only': 0,
        'auth-only': 0,
        unsupported: 0,
    };
    for (const provider of providers) {
        counts[provider.capability.status] = (counts[provider.capability.status] ?? 0) + 1;
    }
    return counts;
}
