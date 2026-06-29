import { describe, expect, it } from 'vitest';
import { getModelContextLimit, getVendoredModelsDevCatalog } from './models-dev-runtime.js';

describe('getModelContextLimit vendored catalog lookup', () => {
    it('returns a finite positive context limit for a known vendored model', () => {
        // claude-3-5-haiku-20241022 was deprecated upstream; claude-3-5-sonnet-20241022
        // is the stable anthropic entry carrying a 200000-token context window.
        const limit = getModelContextLimit('anthropic', 'claude-3-5-sonnet-20241022');
        expect(typeof limit).toBe('number');
        expect(Number.isFinite(limit)).toBe(true);
        expect(limit ?? 0).toBeGreaterThan(0);
    });

    it('returns undefined for an unknown provider without throwing', () => {
        expect(getModelContextLimit('not-a-real-provider', 'any-model')).toBeUndefined();
    });

    it('returns undefined for an unknown model on a known provider without throwing', () => {
        expect(getModelContextLimit('anthropic', 'not-a-real-model')).toBeUndefined();
    });

    it('returns undefined for the credential-free local provider which has no catalog limit', () => {
        expect(getModelContextLimit('local', 'local-echo')).toBeUndefined();
    });

    it('contract: at least one vendored model carries a non-undefined limit.context', () => {
        const catalog = getVendoredModelsDevCatalog();
        const withContextLimit = catalog.providers.flatMap((provider) =>
            provider.models
                .filter((model) => model.limit?.context !== undefined)
                .map((model) => ({ providerID: provider.id, modelID: model.id, context: model.limit?.context })),
        );
        expect(withContextLimit.length).toBeGreaterThan(0);
        // Spot-check: anthropic contributes at least one model with a context limit,
        // proving the runtime path the CLI reads carries the data T3/T4 need.
        const anthropicEntries = withContextLimit.filter((entry) => entry.providerID === 'anthropic');
        expect(anthropicEntries.length).toBeGreaterThan(0);
    });

    it('contract: the regenerated snapshot reports non-trivial context-limit coverage', () => {
        const catalog = getVendoredModelsDevCatalog();
        let total = 0;
        let withLimit = 0;
        for (const provider of catalog.providers) {
            for (const model of provider.models) {
                total++;
                if (model.limit?.context !== undefined) withLimit++;
            }
        }
        expect(total).toBeGreaterThan(0);
        // Coverage should be a strong majority; snapshot regen captured upstream's
        // near-universal limit.context reporting.
        expect(withLimit / total).toBeGreaterThan(0.5);
    });
});
