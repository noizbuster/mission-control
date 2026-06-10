import modelsDevCatalogSnapshot from './generated/models-dev-catalog.json' with { type: 'json' };

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

export const opencodeProviderCatalog: readonly ModelProviderCatalogEntry[] = modelsDevCatalogSnapshot.providers
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
            models: provider.models.map((model) => ({
                id: model.id,
                name: model.name,
                status: 'active',
            })),
        }),
    )
    .sort(compareProvidersByLoginPriority);

export const modelProviderCatalog: readonly ModelProviderCatalogEntry[] = [
    ...scaffoldModelProviderCatalog,
    ...opencodeProviderCatalog,
];

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
