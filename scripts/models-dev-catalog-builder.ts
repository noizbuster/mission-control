import { type GeneratedAuthField, resolveAuthFields } from './models-dev-auth-fields.js';

export const modelsDevURL = 'https://models.dev/api.json';

export type ModelsDevRawCost = {
    readonly input?: number;
    readonly output?: number;
    readonly cache_read?: number;
    readonly cache_write?: number;
};

export type ModelsDevRawModel = {
    readonly name?: string;
    readonly cost?: ModelsDevRawCost | null;
};

export type ModelsDevRawProvider = {
    readonly name?: string;
    readonly env?: readonly string[];
    readonly models?: Record<string, ModelsDevRawModel>;
};

export type ModelsDevRawCatalog = Record<string, ModelsDevRawProvider>;

export type GeneratedCost = {
    readonly inputCentsPerMillion: number;
    readonly outputCentsPerMillion: number;
    readonly cacheReadCentsPerMillion?: number;
};

export type GeneratedModel = {
    readonly id: string;
    readonly name: string;
    readonly status: 'active';
    readonly cost?: GeneratedCost;
};

export type GeneratedProvider = {
    readonly id: string;
    readonly name: string;
    readonly defaultModelID: string;
    readonly authLabel: string;
    readonly authFields: readonly GeneratedAuthField[];
    readonly models: readonly GeneratedModel[];
};

export type GeneratedCatalogSnapshot = {
    readonly source: string;
    readonly generatedAt: string;
    readonly providerCount: number;
    readonly modelCount: number;
    readonly pricedModelCount: number;
    readonly providers: readonly GeneratedProvider[];
};

export type GeneratedPricingEntry = {
    readonly providerID: string;
    readonly modelID: string;
    readonly inputCentsPerMillion: number;
    readonly outputCentsPerMillion: number;
    readonly cacheReadCentsPerMillion?: number;
};

export type GeneratedPricingTable = readonly GeneratedPricingEntry[];

export function buildModelsDevCatalogSnapshot(catalog: ModelsDevRawCatalog): GeneratedCatalogSnapshot {
    const providers = Object.entries(catalog)
        .map(([id, provider]) => buildProvider(id, provider))
        .filter(isDefined)
        .sort((left, right) => left.id.localeCompare(right.id));
    const modelCount = providers.reduce((count, provider) => count + provider.models.length, 0);
    const pricedModelCount = providers.reduce(
        (count, provider) => count + provider.models.filter((model) => model.cost !== undefined).length,
        0,
    );
    return {
        source: modelsDevURL,
        generatedAt: new Date().toISOString(),
        providerCount: providers.length,
        modelCount,
        pricedModelCount,
        providers,
    };
}

export function buildPricingTableFromSnapshot(snapshot: GeneratedCatalogSnapshot): GeneratedPricingTable {
    const entries: GeneratedPricingEntry[] = [];
    for (const provider of snapshot.providers) {
        for (const model of provider.models) {
            if (model.cost === undefined) continue;
            const entry: GeneratedPricingEntry = {
                providerID: provider.id,
                modelID: model.id,
                inputCentsPerMillion: model.cost.inputCentsPerMillion,
                outputCentsPerMillion: model.cost.outputCentsPerMillion,
                ...(model.cost.cacheReadCentsPerMillion !== undefined
                    ? { cacheReadCentsPerMillion: model.cost.cacheReadCentsPerMillion }
                    : {}),
            };
            entries.push(entry);
        }
    }
    return entries;
}

export function parseModelsDevCatalog(value: unknown): ModelsDevRawCatalog {
    if (!isRecord(value)) {
        throw new Error('Models.dev catalog must be an object');
    }
    return Object.fromEntries(
        Object.entries(value).map(([providerID, provider]) => [providerID, parseProvider(providerID, provider)]),
    );
}

function buildProvider(id: string, provider: ModelsDevRawProvider): GeneratedProvider | undefined {
    const models = Object.entries(provider.models ?? {})
        .map(([modelID, model]) => {
            const cost = buildCost(model.cost);
            return {
                id: modelID,
                name: model.name ?? modelID,
                status: 'active' as const,
                ...(cost !== undefined ? { cost } : {}),
            };
        })
        .sort((left, right) => left.id.localeCompare(right.id));
    const defaultModelID = models[0]?.id;
    if (provider.name === undefined || defaultModelID === undefined) {
        return undefined;
    }
    const authFields = resolveAuthFields(id, provider.env ?? []);
    const authLabel = authFields[0]?.label ?? 'API key';
    return {
        id,
        name: provider.name,
        defaultModelID,
        authLabel,
        authFields,
        models,
    };
}

/** Converts upstream dollars-per-million to integer cents-per-million. Skips entries missing input/output. */
function buildCost(cost: ModelsDevRawCost | null | undefined): GeneratedCost | undefined {
    if (cost === null || cost === undefined) return undefined;
    const input = cost.input;
    const output = cost.output;
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) return undefined;
    if (typeof output !== 'number' || !Number.isFinite(output) || output < 0) return undefined;
    const cacheRead = cost.cache_read;
    return {
        inputCentsPerMillion: Math.round(input * 100),
        outputCentsPerMillion: Math.round(output * 100),
        ...(typeof cacheRead === 'number' && Number.isFinite(cacheRead) && cacheRead >= 0
            ? { cacheReadCentsPerMillion: Math.round(cacheRead * 100) }
            : {}),
    };
}

function parseProvider(providerID: string, value: unknown): ModelsDevRawProvider {
    if (!isRecord(value)) {
        throw new Error(`Models.dev provider ${providerID} must be an object`);
    }
    const name = value['name'];
    const env = value['env'];
    const models = value['models'];
    if (typeof name !== 'string') {
        throw new Error(`Models.dev provider ${providerID} requires a string name`);
    }
    if (env !== undefined && !isStringArray(env)) {
        throw new Error(`Models.dev provider ${providerID} env must be a string array`);
    }
    if (!isRecord(models)) {
        throw new Error(`Models.dev provider ${providerID} requires models`);
    }
    return {
        name,
        ...(env !== undefined ? { env } : {}),
        models: parseModels(providerID, models),
    };
}

function parseModels(providerID: string, models: Record<string, unknown>): Record<string, ModelsDevRawModel> {
    return Object.fromEntries(
        Object.entries(models).map(([modelID, model]) => {
            if (!isRecord(model)) {
                throw new Error(`Models.dev model ${providerID}/${modelID} must be an object`);
            }
            const name = model['name'];
            if (name !== undefined && typeof name !== 'string') {
                throw new Error(`Models.dev model ${providerID}/${modelID} name must be a string`);
            }
            const cost = parseCost(model['cost']);
            return [
                modelID,
                {
                    ...(name !== undefined ? { name } : {}),
                    ...(cost !== undefined ? { cost } : {}),
                },
            ] as const;
        }),
    );
}

function parseCost(value: unknown): ModelsDevRawCost | null | undefined {
    if (value === null) return null;
    if (value === undefined) return undefined;
    if (!isRecord(value)) {
        throw new Error('Models.dev model cost must be an object');
    }
    const input = value['input'];
    const output = value['output'];
    const cacheRead = value['cache_read'];
    const cacheWrite = value['cache_write'];
    const result: Record<string, number> = {};
    if (typeof input === 'number') result['input'] = input;
    if (typeof output === 'number') result['output'] = output;
    if (typeof cacheRead === 'number') result['cache_read'] = cacheRead;
    if (typeof cacheWrite === 'number') result['cache_write'] = cacheWrite;
    return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}
