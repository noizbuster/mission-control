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
});
