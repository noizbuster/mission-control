import type { ModelProviderCatalogEntry } from '@mission-control/config';
import type { ProviderCredential } from '@mission-control/protocol';

export type ModelDiscoveryInput = {
    readonly provider: ModelProviderCatalogEntry;
    readonly credential: ProviderCredential;
};

export type ModelDiscovery = (input: ModelDiscoveryInput) => Promise<readonly string[] | undefined>;

type ModelDiscoveryRequestInit = {
    readonly method: 'GET';
    readonly headers: Readonly<Record<string, string>>;
    readonly signal: AbortSignal;
};

type ModelDiscoveryResponse = {
    readonly ok: boolean;
    readonly json: () => Promise<unknown>;
};

export type ModelDiscoveryFetch = (url: string, init: ModelDiscoveryRequestInit) => Promise<ModelDiscoveryResponse>;

const modelDiscoveryTimeoutMs = 5_000;
const anthropicAPIVersion = '2023-06-01';

export function createDefaultModelDiscovery(fetcher: ModelDiscoveryFetch = defaultModelDiscoveryFetch): ModelDiscovery {
    return async (input) => {
        const apiKey = resolveDiscoveryApiKey(input.provider, input.credential);
        if (apiKey === undefined) {
            return undefined;
        }
        const request = createDiscoveryRequest(input.provider.id, apiKey);
        if (request === undefined) {
            return undefined;
        }
        return requestModelIDs(request.url, request.headers, fetcher);
    };
}

type DiscoveryRequest = {
    readonly url: string;
    readonly headers: Readonly<Record<string, string>>;
};

function createDiscoveryRequest(providerID: string, apiKey: string): DiscoveryRequest | undefined {
    switch (providerID) {
        case 'anthropic':
            return {
                url: 'https://api.anthropic.com/v1/models',
                headers: {
                    'anthropic-version': anthropicAPIVersion,
                    'x-api-key': apiKey,
                },
            };
        case 'cohere':
            return createBearerDiscoveryRequest(
                'https://api.cohere.com/v1/models?page_size=1000&endpoint=chat',
                apiKey,
            );
        case 'deepseek':
            return createBearerDiscoveryRequest('https://api.deepseek.com/models', apiKey);
        case 'google':
            return {
                url: 'https://generativelanguage.googleapis.com/v1beta/models',
                headers: { 'x-goog-api-key': apiKey },
            };
        case 'groq':
            return createBearerDiscoveryRequest('https://api.groq.com/openai/v1/models', apiKey);
        case 'mistral':
            return createBearerDiscoveryRequest('https://api.mistral.ai/v1/models', apiKey);
        case 'openai':
            return createBearerDiscoveryRequest('https://api.openai.com/v1/models', apiKey);
        case 'openrouter':
            return createBearerDiscoveryRequest('https://openrouter.ai/api/v1/models', apiKey);
        case 'perplexity':
            return createBearerDiscoveryRequest('https://api.perplexity.ai/v1/models', apiKey);
        case 'togetherai':
            return createBearerDiscoveryRequest('https://api.together.xyz/v1/models', apiKey);
        case 'xai':
            return createBearerDiscoveryRequest('https://api.x.ai/v1/models', apiKey);
        case 'zai-coding-plan':
            return createBearerDiscoveryRequest('https://api.z.ai/api/paas/v4/models', apiKey);
        default:
            return undefined;
    }
}

function createBearerDiscoveryRequest(url: string, apiKey: string): DiscoveryRequest {
    return {
        url,
        headers: { Authorization: `Bearer ${apiKey}` },
    };
}

async function defaultModelDiscoveryFetch(
    url: string,
    init: ModelDiscoveryRequestInit,
): Promise<ModelDiscoveryResponse> {
    return fetch(url, init);
}

async function requestModelIDs(
    url: string,
    headers: Readonly<Record<string, string>>,
    fetcher: ModelDiscoveryFetch,
): Promise<readonly string[] | undefined> {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
        controller.abort();
    }, modelDiscoveryTimeoutMs);

    try {
        const response = await fetcher(url, {
            method: 'GET',
            headers,
            signal: controller.signal,
        });
        if (!response.ok) {
            return undefined;
        }
        return parseModelIDs(await response.json());
    } catch (error: unknown) {
        if (!(error instanceof Error)) {
            throw error;
        }
        return undefined;
    } finally {
        clearTimeout(timeout);
    }
}

function parseModelIDs(value: unknown): readonly string[] | undefined {
    const models = readModelList(value);
    if (models === undefined) {
        return undefined;
    }
    const modelIDs: string[] = [];
    for (const item of models) {
        const modelID = readModelID(item);
        if (modelID === undefined) {
            continue;
        }
        modelIDs.push(modelID);
    }
    return modelIDs;
}

function resolveDiscoveryApiKey(
    provider: ModelProviderCatalogEntry,
    credential: ProviderCredential,
): string | undefined {
    switch (credential.type) {
        case 'apiKey':
            return credential.apiKey;
        case 'fields': {
            const primarySecretField = provider.authFields.find((field) => field.secret);
            if (primarySecretField === undefined) {
                return undefined;
            }
            return credential.fields[primarySecretField.id]?.value;
        }
        case 'oauth':
            return undefined;
        default:
            return assertNever(credential);
    }
}

function readModelList(value: unknown): readonly unknown[] | undefined {
    if (Array.isArray(value)) {
        return value;
    }
    if (!hasModelListContainer(value)) {
        return undefined;
    }
    if (Array.isArray(value.data)) {
        return value.data;
    }
    if (Array.isArray(value.models)) {
        return value.models;
    }
    return undefined;
}

function readModelID(value: unknown): string | undefined {
    if (!hasModelIDContainer(value)) {
        return undefined;
    }
    const rawID = value.id ?? value.name;
    if (rawID === undefined || rawID.length === 0) {
        return undefined;
    }
    return rawID.startsWith('models/') ? rawID.slice('models/'.length) : rawID;
}

function hasModelListContainer(value: unknown): value is {
    readonly data?: readonly unknown[];
    readonly models?: readonly unknown[];
} {
    return (
        typeof value === 'object' && value !== null && !Array.isArray(value) && ('data' in value || 'models' in value)
    );
}

function hasModelIDContainer(value: unknown): value is {
    readonly id?: string;
    readonly name?: string;
} {
    return (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        (('id' in value && typeof value.id === 'string') || ('name' in value && typeof value.name === 'string'))
    );
}

function assertNever(value: never): never {
    void value;
    throw new Error('Unhandled provider credential type');
}
