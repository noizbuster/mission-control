import { describe, expect, it } from 'vitest';
import {
    buildModelsDevCatalogSnapshot,
    buildPricingTableFromSnapshot,
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

describe('models-dev-catalog-builder context limit extraction', () => {
    it('attaches parsed limit to a GeneratedModel when upstream provides context and output', () => {
        const snapshot = buildModelsDevCatalogSnapshot({
            p: {
                name: 'P',
                models: {
                    'with-limit': {
                        name: 'With Limit',
                        limit: { context: 200000, output: 64000 },
                    },
                },
            },
        });
        const provider = snapshot.providers.find((entry) => entry.id === 'p');
        const model = provider?.models.find((entry) => entry.id === 'with-limit');
        expect(model?.limit).toEqual({ context: 200000, output: 64000 });
    });

    it('emits limit with only context when output is absent upstream', () => {
        const snapshot = buildModelsDevCatalogSnapshot({
            p: {
                name: 'P',
                models: {
                    'ctx-only': {
                        name: 'Ctx Only',
                        limit: { context: 128000 },
                    },
                },
            },
        });
        const provider = snapshot.providers.find((entry) => entry.id === 'p');
        const model = provider?.models.find((entry) => entry.id === 'ctx-only');
        expect(model?.limit).toEqual({ context: 128000 });
        expect(model?.limit && 'output' in model.limit).toBe(false);
    });

    it('drops limit entirely when upstream is null, undefined, or malformed', () => {
        const snapshot = buildModelsDevCatalogSnapshot({
            p: {
                name: 'P',
                models: {
                    'null-limit': { name: 'Null', limit: null },
                    'missing-limit': { name: 'Missing' },
                    'bad-limit': {
                        name: 'Bad',
                        limit: { context: 'no', output: 'also-no' } as unknown as { context: number; output: number },
                    },
                },
            },
        });
        const provider = snapshot.providers.find((entry) => entry.id === 'p');
        expect(provider?.models.find((entry) => entry.id === 'null-limit')?.limit).toBeUndefined();
        expect(provider?.models.find((entry) => entry.id === 'missing-limit')?.limit).toBeUndefined();
        expect(provider?.models.find((entry) => entry.id === 'bad-limit')?.limit).toBeUndefined();
    });

    it('drops limit when context or output is negative or non-finite', () => {
        const snapshot = buildModelsDevCatalogSnapshot({
            p: {
                name: 'P',
                models: {
                    'neg-context': { name: 'Neg Ctx', limit: { context: -1, output: 64000 } },
                    'nan-output': { name: 'NaN Out', limit: { context: 200000, output: Number.NaN } },
                    infinity: { name: 'Inf', limit: { context: Number.POSITIVE_INFINITY } },
                    ok: { name: 'OK', limit: { context: 200000, output: 8000 } },
                },
            },
        });
        const provider = snapshot.providers.find((entry) => entry.id === 'p');
        expect(provider?.models.find((entry) => entry.id === 'neg-context')?.limit).toBeUndefined();
        expect(provider?.models.find((entry) => entry.id === 'nan-output')?.limit).toBeUndefined();
        expect(provider?.models.find((entry) => entry.id === 'infinity')?.limit).toBeUndefined();
        expect(provider?.models.find((entry) => entry.id === 'ok')?.limit).toEqual({
            context: 200000,
            output: 8000,
        });
    });

    it('coexists with cost on the same model without interference', () => {
        const snapshot = buildModelsDevCatalogSnapshot({
            p: {
                name: 'P',
                models: {
                    'priced-limited': {
                        name: 'Priced Limited',
                        cost: { input: 3, output: 15 },
                        limit: { context: 200000, output: 64000 },
                    },
                },
            },
        });
        const provider = snapshot.providers.find((entry) => entry.id === 'p');
        const model = provider?.models.find((entry) => entry.id === 'priced-limited');
        expect(model?.cost).toEqual({ inputCentsPerMillion: 300, outputCentsPerMillion: 1500 });
        expect(model?.limit).toEqual({ context: 200000, output: 64000 });
    });
});
