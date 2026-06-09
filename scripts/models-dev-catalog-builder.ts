import { type GeneratedAuthField, resolveAuthFields } from './models-dev-auth-fields.js';

export const modelsDevURL = 'https://models.dev/api.json';

export type ModelsDevRawModel = {
    readonly name?: string;
};

export type ModelsDevRawProvider = {
    readonly name?: string;
    readonly env?: readonly string[];
    readonly models?: Record<string, ModelsDevRawModel>;
};

export type ModelsDevRawCatalog = Record<string, ModelsDevRawProvider>;

export type GeneratedModel = {
    readonly id: string;
    readonly name: string;
    readonly status: 'active';
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
    readonly providers: readonly GeneratedProvider[];
};

export function buildModelsDevCatalogSnapshot(catalog: ModelsDevRawCatalog): GeneratedCatalogSnapshot {
    const providers = Object.entries(catalog)
        .map(([id, provider]) => buildProvider(id, provider))
        .filter(isDefined)
        .sort((left, right) => left.id.localeCompare(right.id));
    const modelCount = providers.reduce((count, provider) => count + provider.models.length, 0);
    return {
        source: modelsDevURL,
        generatedAt: new Date().toISOString(),
        providerCount: providers.length,
        modelCount,
        providers,
    };
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
        .map(([modelID, model]) => ({
            id: modelID,
            name: model.name ?? modelID,
            status: 'active' as const,
        }))
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
            return [modelID, { ...(name !== undefined ? { name } : {}) }] as const;
        }),
    );
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
