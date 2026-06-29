import type { ProviderExecutionCapability } from '@mission-control/protocol';
import modelsDevCatalogSnapshot from './generated/models-dev-catalog.json' with { type: 'json' };
import { variantsForGeneratedModel } from './model-variant-presets.js';
import { generatedDefaultProviderCapability, generatedProviderCapabilities } from './provider-capabilities.js';

export { getModelContextLimit } from './models-dev-runtime.js';

export const appName = 'mission-control';
export const cliCommandName = 'mctrl';
export const sidecarBinaryName = 'mission-control-sidecar';
export const missionControlAuthFileEnvKey = 'MISSION_CONTROL_AUTH_FILE';
export const missionControlAuthSchemaURL = 'https://mission-control.local/auth.schema.json';

export type ProviderAuthField = {
    readonly id: string;
    readonly label: string;
    readonly env: readonly string[];
    readonly secret: boolean;
    readonly required: boolean;
};

export type ProviderAuthMethod = {
    readonly id: string;
    readonly type: 'apiKey' | 'oauth';
    readonly label: string;
    readonly flow?: 'authorizationCodePkce' | 'deviceCode' | 'headlessDeviceCode';
};

export type ModelCatalogEntry = {
    readonly id: string;
    readonly name: string;
    readonly status: 'active';
    readonly variants?: readonly {
        readonly id: string;
        readonly name: string;
        readonly status: 'active';
    }[];
};

export type ModelProviderCatalogEntry = {
    readonly id: string;
    readonly name: string;
    readonly defaultModelID: string;
    readonly authLabel: string;
    readonly authFields: readonly ProviderAuthField[];
    readonly authMethods: readonly ProviderAuthMethod[];
    readonly capability: ProviderExecutionCapability;
    readonly models: readonly ModelCatalogEntry[];
};

const apiKeyAuthFields = [
    {
        id: 'apiKey',
        label: 'API key',
        env: [],
        secret: true,
        required: true,
    },
] as const satisfies readonly ProviderAuthField[];

const providerLoginPriority = [
    'opencode',
    'openai',
    'github-copilot',
    'google',
    'anthropic',
    'openrouter',
    'vercel',
] as const;
const providerLoginPriorityRank = new Map<string, number>(
    providerLoginPriority.map((providerID, index) => [providerID, index]),
);

const openAIAuthMethods = [
    {
        id: 'oauth-browser',
        type: 'oauth',
        label: 'ChatGPT Pro/Plus (browser)',
        flow: 'authorizationCodePkce',
    },
    {
        id: 'oauth-headless',
        type: 'oauth',
        label: 'ChatGPT Pro/Plus (headless)',
        flow: 'headlessDeviceCode',
    },
    {
        id: 'api-key',
        type: 'apiKey',
        label: 'Manually enter API Key',
    },
] as const satisfies readonly ProviderAuthMethod[];

const githubCopilotAuthMethods = [
    {
        id: 'oauth-device',
        type: 'oauth',
        label: 'Login with GitHub Copilot',
        flow: 'deviceCode',
    },
    {
        id: 'api-key',
        type: 'apiKey',
        label: 'Manually enter API Key',
    },
] as const satisfies readonly ProviderAuthMethod[];

const localProviderCapability = {
    status: 'executable',
    adapterFamily: 'local',
} as const satisfies ProviderExecutionCapability;

export const defaultModelProviderSelection = {
    providerID: 'local',
    modelID: 'local-echo',
} as const;

const scaffoldModelProviderCatalog = [
    {
        id: 'local',
        name: 'Local Sandbox',
        defaultModelID: 'local-echo',
        authLabel: 'API key',
        authFields: apiKeyAuthFields,
        authMethods: [createApiKeyAuthMethod('API key')],
        capability: localProviderCapability,
        models: [
            {
                id: 'local-echo',
                name: 'Local Echo',
                status: 'active',
                variants: [
                    {
                        id: 'default',
                        name: 'Default',
                        status: 'active',
                    },
                    {
                        id: 'fast',
                        name: 'Fast',
                        status: 'active',
                    },
                    {
                        id: 'reasoning-low',
                        name: 'Reasoning Low',
                        status: 'active',
                    },
                    {
                        id: 'reasoning-medium',
                        name: 'Reasoning Medium',
                        status: 'active',
                    },
                    {
                        id: 'reasoning-high',
                        name: 'Reasoning High',
                        status: 'active',
                    },
                    {
                        id: 'thinking',
                        name: 'Thinking',
                        status: 'active',
                    },
                ],
            },
        ],
    },
] as const satisfies readonly ModelProviderCatalogEntry[];

export const opencodeProviderCatalog: readonly ModelProviderCatalogEntry[] =
    transformRawCatalog(modelsDevCatalogSnapshot);

export const modelProviderCatalog: readonly ModelProviderCatalogEntry[] = [
    ...scaffoldModelProviderCatalog,
    ...opencodeProviderCatalog,
];

export async function getRuntimeModelProviderCatalog(): Promise<readonly ModelProviderCatalogEntry[]> {
    const { loadModelsDevCatalog } = await import('./models-dev-runtime.js');
    type RawModelsDevCatalog = import('./models-dev-runtime.js').RawModelsDevCatalog;
    const rawCatalog: RawModelsDevCatalog = await loadModelsDevCatalog();
    return [...scaffoldModelProviderCatalog, ...transformRawCatalog(rawCatalog)];
}

function transformRawCatalog(
    rawCatalog: import('./models-dev-runtime.js').RawModelsDevCatalog,
): readonly ModelProviderCatalogEntry[] {
    return rawCatalog.providers
        .map(
            (provider): ModelProviderCatalogEntry => ({
                id: provider.id,
                name: provider.name,
                defaultModelID: provider.defaultModelID,
                authLabel: provider.authLabel,
                authFields: provider.authFields.map((field) => ({
                    id: field.id,
                    label: field.label,
                    env: field.env,
                    secret: field.secret,
                    required: field.required,
                })),
                authMethods: createProviderAuthMethods(provider.id, provider.authLabel),
                capability: capabilityForGeneratedProvider(provider.id),
                models: provider.models.map((model) => {
                    const variants = variantsForGeneratedModel(provider.id, model.id);
                    return {
                        id: model.id,
                        name: model.name,
                        status: 'active',
                        ...(variants !== undefined ? { variants } : {}),
                    };
                }),
            }),
        )
        .sort(compareProvidersByLoginPriority);
}

function createProviderAuthMethods(providerID: string, authLabel: string): readonly ProviderAuthMethod[] {
    switch (providerID) {
        case 'openai':
            return openAIAuthMethods;
        case 'github-copilot':
            return githubCopilotAuthMethods;
        default:
            return [createApiKeyAuthMethod(authLabel)];
    }
}

function createApiKeyAuthMethod(authLabel: string): ProviderAuthMethod {
    return {
        id: 'api-key',
        type: 'apiKey',
        label: authLabel,
    };
}

function capabilityForGeneratedProvider(providerID: string): ProviderExecutionCapability {
    return generatedProviderCapabilities[providerID] ?? generatedDefaultProviderCapability;
}

function compareProvidersByLoginPriority(left: ModelProviderCatalogEntry, right: ModelProviderCatalogEntry): number {
    const leftPriority = getProviderLoginPriority(left.id);
    const rightPriority = getProviderLoginPriority(right.id);
    if (leftPriority !== rightPriority) {
        return leftPriority - rightPriority;
    }
    return left.name.localeCompare(right.name);
}

function getProviderLoginPriority(providerID: string): number {
    return providerLoginPriorityRank.get(providerID) ?? Number.MAX_SAFE_INTEGER;
}
