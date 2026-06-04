import { describe, expect, it } from 'vitest';
import {
    defaultModelProviderSelection,
    missionControlAuthFileEnvKey,
    missionControlAuthSchemaURL,
    modelProviderCatalog,
} from './index.js';

describe('config catalog constants', () => {
    it('exports the default scaffold model provider selection and catalog', () => {
        expect(defaultModelProviderSelection).toEqual({
            providerID: 'mock',
            modelID: 'mission-control-demo',
        });
        expect(modelProviderCatalog.map((provider) => provider.id)).toEqual(['mock', 'local']);
        expect(modelProviderCatalog[0]?.models.map((model) => model.id)).toEqual([
            'mission-control-demo',
            'mission-control-fast',
        ]);
        expect(modelProviderCatalog[1]?.models.map((model) => model.id)).toEqual(['local-echo']);
        expect(modelProviderCatalog.map((provider) => provider.authLabel)).toEqual(['API key', 'API key']);
        expect(missionControlAuthFileEnvKey).toBe('MISSION_CONTROL_AUTH_FILE');
        expect(missionControlAuthSchemaURL).toBe('https://mission-control.local/auth.schema.json');
    });

    it('exports scaffold model variants', () => {
        const mockProvider = modelProviderCatalog.find((provider) => provider.id === 'mock');
        const localProvider = modelProviderCatalog.find((provider) => provider.id === 'local');
        const demoModel = mockProvider?.models.find((model) => model.id === 'mission-control-demo');
        const fastModel = mockProvider?.models.find((model) => model.id === 'mission-control-fast');
        const localModel = localProvider?.models.find((model) => model.id === 'local-echo');

        expect(demoModel?.variants?.map((variant) => variant.id)).toEqual(['default']);
        expect(fastModel?.variants?.map((variant) => variant.id)).toEqual(['cheap']);
        expect(localModel?.variants?.map((variant) => variant.id)).toEqual(['default']);
    });
});
