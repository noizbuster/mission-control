import type { ModelPattern, ProviderAuthStore } from '@mission-control/core';
import type { ModelProviderSelection, ModelRole } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import { buildRoleConfigFromAuth, modelRolesToRoleConfig } from './model-role-config';

function makeStore(roles: Partial<Record<ModelRole, ModelProviderSelection>>): ProviderAuthStore {
    return {
        authFilePath: '/tmp/mission-control-role-config-test.json',
        readAuthFile: async () => ({ $schema: 'https://mission-control.local/auth.schema.json', credentials: {} }),
        saveCredential: async () => {},
        setDefaultSelection: async () => {},
        deleteCredential: async () => {},
        listCredentialSummaries: async () => [],
        getDefaultSelection: async () => undefined,
        getModelRoles: async () => roles,
        setModelRole: async () => {},
        clearModelRole: async () => {},
    };
}

describe('modelRolesToRoleConfig', () => {
    it('returns an empty object for no assignments', () => {
        expect(modelRolesToRoleConfig({})).toEqual({});
    });

    it('maps a persisted selection into a ModelPattern', () => {
        const result = modelRolesToRoleConfig({ slow: { providerID: 'a', modelID: 'b' } });
        expect(result).toEqual({ slow: { providerID: 'a', modelID: 'b' } });
    });

    it('preserves variantID when present', () => {
        const result = modelRolesToRoleConfig({
            vision: { providerID: 'openai', modelID: 'gpt-4o', variantID: 'reasoning-high' },
        });
        expect(result).toEqual({
            vision: { providerID: 'openai', modelID: 'gpt-4o', variantID: 'reasoning-high' },
        });
    });

    it('omits variantID entirely when absent (no explicit undefined)', () => {
        const result = modelRolesToRoleConfig({ slow: { providerID: 'a', modelID: 'b' } });
        expect(result.slow).not.toHaveProperty('variantID');
    });

    it('converts multiple roles independently', () => {
        const result = modelRolesToRoleConfig({
            slow: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
            smol: { providerID: 'openai', modelID: 'gpt-4o-mini' },
        });
        expect(result).toEqual({
            slow: { providerID: 'anthropic', modelID: 'claude-sonnet-4-6' },
            smol: { providerID: 'openai', modelID: 'gpt-4o-mini' },
        });
    });
});

describe('buildRoleConfigFromAuth', () => {
    it('delegates to modelRolesToRoleConfig after reading getModelRoles', async () => {
        const roles: Partial<Record<ModelRole, ModelProviderSelection>> = {
            slow: { providerID: 'a', modelID: 'b' },
        };
        const store = makeStore(roles);
        const getModelRoles = vi.spyOn(store, 'getModelRoles');

        const result = await buildRoleConfigFromAuth(store);

        expect(getModelRoles).toHaveBeenCalledOnce();
        expect(result).toEqual({ slow: { providerID: 'a', modelID: 'b' } satisfies ModelPattern });
    });

    it('returns an empty config when the store has no roles', async () => {
        const store = makeStore({});
        await expect(buildRoleConfigFromAuth(store)).resolves.toEqual({});
    });
});
