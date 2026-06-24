import { describe, expect, it } from 'vitest';
import {
    buildModelsDevCatalogSnapshot,
    buildPricingTableFromSnapshot,
    type GeneratedCatalogSnapshot,
    type ModelsDevRawCatalog,
} from './models-dev-catalog-builder.js';

function makeRawCatalog(overrides: Partial<ModelsDevRawCatalog> = {}): ModelsDevRawCatalog {
    return {
        providerA: {
            name: 'Provider A',
            models: {
                'model-with-pricing': {
                    name: 'Model With Pricing',
                    cost: { input: 3, output: 15, cache_read: 0.75 },
                },
                'model-no-cache-read': {
                    name: 'Model No Cache',
                    cost: { input: 0.5, output: 1.5 },
                },
                'model-null-cost': {
                    name: 'Model Null',
                    cost: null,
                },
                'model-missing-cost': {
                    name: 'Model Missing',
                },
                'model-bad-cost': {
                    name: 'Model Bad',
                    cost: { input: 'no' } as unknown as { input: number },
                },
            },
        },
        ...overrides,
    } as ModelsDevRawCatalog;
}

describe('models-dev-catalog-builder pricing extraction', () => {
    it('counts priced vs unpriced models in the snapshot', () => {
        const snapshot = buildModelsDevCatalogSnapshot(makeRawCatalog());
        expect(snapshot.modelCount).toBe(5);
        expect(snapshot.pricedModelCount).toBe(2);
    });

    it('attaches integer cents-per-million to models with valid cost', () => {
        const snapshot = buildModelsDevCatalogSnapshot(makeRawCatalog());
        const providerA = snapshot.providers.find((p) => p.id === 'providerA');
        expect(providerA).toBeDefined();
        const withPricing = providerA?.models.find((m) => m.id === 'model-with-pricing');
        expect(withPricing?.cost).toEqual({
            inputCentsPerMillion: 300,
            outputCentsPerMillion: 1500,
            cacheReadCentsPerMillion: 75,
        });
    });

    it('omits cost field entirely when upstream is null, undefined, or malformed', () => {
        const snapshot = buildModelsDevCatalogSnapshot(makeRawCatalog());
        const providerA = snapshot.providers.find((p) => p.id === 'providerA');
        expect(providerA?.models.find((m) => m.id === 'model-null-cost')?.cost).toBeUndefined();
        expect(providerA?.models.find((m) => m.id === 'model-missing-cost')?.cost).toBeUndefined();
        expect(providerA?.models.find((m) => m.id === 'model-bad-cost')?.cost).toBeUndefined();
    });

    it('omits cacheReadCentsPerMillion when upstream cache_read is missing', () => {
        const snapshot = buildModelsDevCatalogSnapshot(makeRawCatalog());
        const providerA = snapshot.providers.find((p) => p.id === 'providerA');
        const noCache = providerA?.models.find((m) => m.id === 'model-no-cache-read');
        expect(noCache?.cost).toEqual({
            inputCentsPerMillion: 50,
            outputCentsPerMillion: 150,
        });
        expect(noCache?.cost && 'cacheReadCentsPerMillion' in noCache.cost).toBe(false);
    });

    it('builds a flat pricing table from the snapshot', () => {
        const snapshot = buildModelsDevCatalogSnapshot(makeRawCatalog());
        const table = buildPricingTableFromSnapshot(snapshot);
        expect(table).toHaveLength(2);
        const entry = table.find((e) => e.modelID === 'model-with-pricing');
        expect(entry).toEqual({
            providerID: 'providerA',
            modelID: 'model-with-pricing',
            inputCentsPerMillion: 300,
            outputCentsPerMillion: 1500,
            cacheReadCentsPerMillion: 75,
        });
    });

    it('rounds fractional dollar amounts to integer cents', () => {
        const snapshot = buildModelsDevCatalogSnapshot({
            p: {
                name: 'P',
                models: {
                    fractional: {
                        name: 'Frac',
                        cost: { input: 0.574, output: 1.721 },
                    },
                },
            },
        });
        const pricing = buildPricingTableFromSnapshot(snapshot);
        expect(pricing[0]).toEqual({
            providerID: 'p',
            modelID: 'fractional',
            inputCentsPerMillion: 57,
            outputCentsPerMillion: 172,
        });
    });

    it('rejects negative input or output prices', () => {
        const snapshot = buildModelsDevCatalogSnapshot({
            p: {
                name: 'P',
                models: {
                    neg: { name: 'N', cost: { input: -1, output: 5 } },
                    nan: { name: 'NaN', cost: { input: Number.NaN, output: 5 } },
                    ok: { name: 'OK', cost: { input: 1, output: 5 } },
                },
            },
        });
        const pricing = buildPricingTableFromSnapshot(snapshot);
        expect(pricing).toHaveLength(1);
        expect(pricing[0]?.modelID).toBe('ok');
    });
});
