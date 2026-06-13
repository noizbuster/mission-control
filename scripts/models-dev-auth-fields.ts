export type GeneratedAuthField = {
    readonly id: string;
    readonly label: string;
    readonly env: readonly string[];
    readonly secret: boolean;
    readonly required: boolean;
};

const authFieldOverrides: Readonly<Record<string, readonly GeneratedAuthField[]>> = {
    google: [
        {
            id: 'apiKey',
            label: 'Google API key',
            env: ['GOOGLE_API_KEY', 'GOOGLE_GENERATIVE_AI_API_KEY', 'GEMINI_API_KEY'],
            secret: true,
            required: true,
        },
    ],
    azure: [
        field('resourceName', 'Azure resource name', ['AZURE_RESOURCE_NAME'], false),
        field('apiKey', 'Azure API key', ['AZURE_API_KEY'], true),
    ],
    'azure-cognitive-services': [
        field(
            'resourceName',
            'Azure Cognitive Services resource name',
            ['AZURE_COGNITIVE_SERVICES_RESOURCE_NAME'],
            false,
        ),
        field('apiKey', 'Azure Cognitive Services API key', ['AZURE_COGNITIVE_SERVICES_API_KEY'], true),
    ],
    'cloudflare-ai-gateway': [
        field('apiToken', 'Cloudflare API token', ['CLOUDFLARE_API_TOKEN'], true),
        field('accountId', 'Cloudflare account ID', ['CLOUDFLARE_ACCOUNT_ID'], false),
        field('gatewayId', 'Cloudflare gateway ID', ['CLOUDFLARE_GATEWAY_ID'], false),
    ],
    'cloudflare-workers-ai': [
        field('accountId', 'Cloudflare account ID', ['CLOUDFLARE_ACCOUNT_ID'], false),
        field('apiKey', 'Cloudflare API key', ['CLOUDFLARE_API_KEY'], true),
    ],
    databricks: [
        field('host', 'Databricks host', ['DATABRICKS_HOST'], false),
        field('token', 'Databricks token', ['DATABRICKS_TOKEN'], true),
    ],
    'google-vertex': createGoogleVertexAuthFields(),
    'google-vertex-anthropic': createGoogleVertexAuthFields(),
    'amazon-bedrock': [
        field('region', 'AWS region', ['AWS_REGION'], false),
        field('accessKeyId', 'AWS access key ID', ['AWS_ACCESS_KEY_ID'], true),
        field('secretAccessKey', 'AWS secret access key', ['AWS_SECRET_ACCESS_KEY'], true),
        field('bearerToken', 'AWS Bedrock bearer token', ['AWS_BEARER_TOKEN_BEDROCK'], true, false),
    ],
    'privatemode-ai': [
        field('apiKey', 'Privatemode API key', ['PRIVATEMODE_API_KEY'], true),
        field('endpoint', 'Privatemode endpoint', ['PRIVATEMODE_ENDPOINT'], false),
    ],
    'snowflake-cortex': [
        field('account', 'Snowflake account', ['SNOWFLAKE_ACCOUNT'], false),
        field('pat', 'Snowflake Cortex PAT', ['SNOWFLAKE_CORTEX_PAT'], true),
    ],
};

export function resolveAuthFields(providerID: string, env: readonly string[]): readonly GeneratedAuthField[] {
    const override = authFieldOverrides[providerID];
    if (override !== undefined) {
        return override;
    }
    const primaryEnv = env[0];
    if (primaryEnv === undefined) {
        return [field('apiKey', 'API key', [], true)];
    }
    return [
        {
            id: 'apiKey',
            label: primaryEnv,
            env,
            secret: true,
            required: true,
        },
    ];
}

function createGoogleVertexAuthFields(): readonly GeneratedAuthField[] {
    return [
        field('project', 'Google Vertex project', ['GOOGLE_VERTEX_PROJECT'], false),
        field('location', 'Google Vertex location', ['GOOGLE_VERTEX_LOCATION'], false),
        field('applicationCredentials', 'Google application credentials', ['GOOGLE_APPLICATION_CREDENTIALS'], false),
    ];
}

function field(
    id: string,
    label: string,
    env: readonly string[],
    secret: boolean,
    required = true,
): GeneratedAuthField {
    return { id, label, env, secret, required };
}
