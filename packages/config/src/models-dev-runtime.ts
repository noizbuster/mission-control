import modelsDevCatalogSnapshot from './generated/models-dev-catalog.json' with { type: 'json' };
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const modelsDevURL = 'https://models.dev/api.json';
const cacheTTLms = 5 * 60 * 1000;

export type RawModelsDevModel = {
    readonly id: string;
    readonly name: string;
    readonly status?: string;
};

export type RawModelsDevAuthField = {
    readonly id: string;
    readonly label: string;
    readonly env: readonly string[];
    readonly secret: boolean;
    readonly required: boolean;
};

export type RawModelsDevProvider = {
    readonly id: string;
    readonly name: string;
    readonly defaultModelID: string;
    readonly authLabel: string;
    readonly authFields: readonly RawModelsDevAuthField[];
    readonly models: readonly RawModelsDevModel[];
};

export type RawModelsDevCatalog = {
    readonly providers: readonly RawModelsDevProvider[];
};

let cachedCatalog: RawModelsDevCatalog | undefined;
let fetchPromise: Promise<RawModelsDevCatalog | undefined> | undefined;

export function getCachedModelsDevCatalog(): RawModelsDevCatalog | undefined {
    return cachedCatalog;
}

export function getVendoredModelsDevCatalog(): RawModelsDevCatalog {
    return modelsDevCatalogSnapshot;
}

/**
 * Loads the models.dev catalog with priority:
 * 1. In-memory cache
 * 2. Disk cache (if within TTL)
 * 3. Vendored snapshot (fallback)
 *
 * Triggers async background refresh when disk cache is stale or missing.
 * Never throws — falls back to the vendored snapshot if a refresh errors.
 */
export async function loadModelsDevCatalog(): Promise<RawModelsDevCatalog> {
    if (cachedCatalog !== undefined) {
        return cachedCatalog;
    }

    try {
        const cachePath = resolveCachePath();
        const cacheStat = await stat(cachePath);
        const age = Date.now() - cacheStat.mtimeMs;
        const raw = await readFile(cachePath, 'utf8');
        const parsed = parseCachedCatalog(raw);
        if (parsed !== undefined) {
            cachedCatalog = parsed;
            if (age >= cacheTTLms) {
                refreshModelsDevCatalog().catch(() => {});
            }
            return parsed;
        }
    } catch {
        // No cache file or corrupt — fall through to vendored
    }

    const vendored = getVendoredModelsDevCatalog();
    refreshModelsDevCatalog().catch(() => {});
    return vendored;
}

/**
 * Fetches latest catalog from models.dev, writes transformed result to disk,
 * and updates the in-memory cache. Never throws.
 */
export async function refreshModelsDevCatalog(): Promise<RawModelsDevCatalog | undefined> {
    if (fetchPromise !== undefined) {
        return fetchPromise;
    }

    fetchPromise = (async (): Promise<RawModelsDevCatalog | undefined> => {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            try {
                const response = await fetch(modelsDevURL, {
                    signal: controller.signal,
                    headers: { 'User-Agent': 'mission-control/cli' },
                });
                if (!response.ok) return undefined;
                const text = await response.text();
                const transformed = transformModelsDevResponse(JSON.parse(text));
                if (transformed === undefined || transformed.providers.length === 0) {
                    return undefined;
                }

                const cachePath = resolveCachePath();
                await mkdir(dirname(cachePath), { recursive: true });
                await writeFile(cachePath, JSON.stringify(transformed), 'utf8');

                cachedCatalog = transformed;
                return transformed;
            } finally {
                clearTimeout(timeout);
            }
        } catch {
            return undefined;
        } finally {
            fetchPromise = undefined;
        }
    })();

    return fetchPromise;
}

function resolveCachePath(): string {
    const xdgCache = process.env['XDG_CACHE_HOME'];
    const baseDir = xdgCache !== undefined && xdgCache.length > 0 ? xdgCache : join(homedir(), '.cache');
    return join(baseDir, 'mission-control', 'models.json');
}

function parseCachedCatalog(text: string): RawModelsDevCatalog | undefined {
    try {
        const value: unknown = JSON.parse(text);
        if (isRawModelsDevCatalog(value)) return value;
        return undefined;
    } catch {
        return undefined;
    }
}

function isRawModelsDevCatalog(value: unknown): value is RawModelsDevCatalog {
    if (!isRecord(value)) return false;
    const providers = value['providers'];
    return Array.isArray(providers);
}

/**
 * Transforms the models.dev API response (Record of providers keyed by ID,
 * each with models as a Record) into our flat catalog format
 * ({ providers: [{ id, name, models: [...] }] }).
 */
function transformModelsDevResponse(raw: unknown): RawModelsDevCatalog | undefined {
    if (!isRecord(raw)) return undefined;

    const providers: RawModelsDevProvider[] = [];
    for (const [providerID, providerValue] of Object.entries(raw)) {
        if (!isRecord(providerValue)) continue;
        const provider = buildProviderFromAPI(providerID, providerValue);
        if (provider !== undefined) {
            providers.push(provider);
        }
    }

    if (providers.length === 0) return undefined;
    return { providers };
}

function buildProviderFromAPI(
    providerID: string,
    providerValue: Record<string, unknown>,
): RawModelsDevProvider | undefined {
    const nameValue = providerValue['name'];
    if (typeof nameValue !== 'string') return undefined;

    const models = buildModelsFromAPI(providerValue['models']);
    if (models.length === 0) return undefined;

    models.sort((left, right) => left.id.localeCompare(right.id));

    const env = isStringArray(providerValue['env']) ? providerValue['env'] : [];
    const authFields = resolveAuthFieldsForProvider(providerID, env);
    const defaultModelID = models[0]?.id ?? '';

    return {
        id: providerID,
        name: nameValue,
        defaultModelID,
        authLabel: authFields[0]?.label ?? 'API key',
        authFields,
        models,
    };
}

function buildModelsFromAPI(modelsValue: unknown): RawModelsDevModel[] {
    if (!isRecord(modelsValue)) return [];
    const models: RawModelsDevModel[] = [];
    for (const [modelID, modelValue] of Object.entries(modelsValue)) {
        if (!isRecord(modelValue)) continue;
        const nameValue = modelValue['name'];
        models.push({
            id: modelID,
            name: typeof nameValue === 'string' ? nameValue : modelID,
            status: 'active',
        });
    }
    return models;
}

function resolveAuthFieldsForProvider(providerID: string, env: readonly string[]): readonly RawModelsDevAuthField[] {
    const override = authFieldOverrides[providerID];
    if (override !== undefined) return override;
    const primaryEnv = env[0];
    if (primaryEnv === undefined) {
        return [authField('apiKey', 'API key', [], true)];
    }
    return [authField('apiKey', primaryEnv, env, true)];
}

function authField(
    id: string,
    label: string,
    env: readonly string[],
    secret: boolean,
    required = true,
): RawModelsDevAuthField {
    return { id, label, env, secret, required };
}

function googleVertexAuthFields(): readonly RawModelsDevAuthField[] {
    return [
        authField('project', 'Google Vertex project', ['GOOGLE_VERTEX_PROJECT'], false),
        authField('location', 'Google Vertex location', ['GOOGLE_VERTEX_LOCATION'], false),
        authField(
            'applicationCredentials',
            'Google application credentials',
            ['GOOGLE_APPLICATION_CREDENTIALS'],
            false,
        ),
    ];
}

const authFieldOverrides: Readonly<Record<string, readonly RawModelsDevAuthField[]>> = {
    google: [
        authField(
            'apiKey',
            'Google API key',
            ['GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
            true,
        ),
    ],
    azure: [
        authField('resourceName', 'Azure resource name', ['AZURE_RESOURCE_NAME'], false),
        authField('apiKey', 'Azure API key', ['AZURE_API_KEY'], true),
    ],
    'azure-cognitive-services': [
        authField(
            'resourceName',
            'Azure Cognitive Services resource name',
            ['AZURE_COGNITIVE_SERVICES_RESOURCE_NAME'],
            false,
        ),
        authField('apiKey', 'Azure Cognitive Services API key', ['AZURE_COGNITIVE_SERVICES_API_KEY'], true),
    ],
    'cloudflare-ai-gateway': [
        authField('apiToken', 'Cloudflare API token', ['CLOUDFLARE_API_TOKEN'], true),
        authField('accountId', 'Cloudflare account ID', ['CLOUDFLARE_ACCOUNT_ID'], false),
        authField('gatewayId', 'Cloudflare gateway ID', ['CLOUDFLARE_GATEWAY_ID'], false),
    ],
    'cloudflare-workers-ai': [
        authField('accountId', 'Cloudflare account ID', ['CLOUDFLARE_ACCOUNT_ID'], false),
        authField('apiKey', 'Cloudflare API key', ['CLOUDFLARE_API_KEY'], true),
    ],
    databricks: [
        authField('host', 'Databricks host', ['DATABRICKS_HOST'], false),
        authField('token', 'Databricks token', ['DATABRICKS_TOKEN'], true),
    ],
    'google-vertex': googleVertexAuthFields(),
    'google-vertex-anthropic': googleVertexAuthFields(),
    'amazon-bedrock': [
        authField('region', 'AWS region', ['AWS_REGION'], false),
        authField('accessKeyId', 'AWS access key ID', ['AWS_ACCESS_KEY_ID'], true),
        authField('secretAccessKey', 'AWS secret access key', ['AWS_SECRET_ACCESS_KEY'], true),
        authField('bearerToken', 'AWS Bedrock bearer token', ['AWS_BEARER_TOKEN_BEDROCK'], true, false),
    ],
    'privatemode-ai': [
        authField('apiKey', 'Privatemode API key', ['PRIVATEMODE_API_KEY'], true),
        authField('endpoint', 'Privatemode endpoint', ['PRIVATEMODE_ENDPOINT'], false),
    ],
    'snowflake-cortex': [
        authField('account', 'Snowflake account', ['SNOWFLAKE_ACCOUNT'], false),
        authField('pat', 'Snowflake Cortex PAT', ['SNOWFLAKE_CORTEX_PAT'], true),
    ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
    return Array.isArray(value) && value.every((entry) => typeof entry === 'string');
}
