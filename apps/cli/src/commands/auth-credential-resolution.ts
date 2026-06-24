import type { ModelProviderCatalogEntry, ProviderAuthField } from '@mission-control/config';
import type { ProviderCredential } from '@mission-control/protocol';
import type { AuthCredentialArg } from '../args.js';
import type { ProviderAuthStore, SaveProviderCredentialFieldInput } from '../auth-store.js';
import type { AuthPrompt, AuthPromptOptions } from './auth-prompts.js';
import { maskSecretHint } from './auth-prompts.js';

type AuthEnvironment = Readonly<Record<string, string | undefined>>;

export type ResolvedProviderCredential =
    | {
          readonly type: 'apiKey';
          readonly apiKey: string;
      }
    | {
          readonly type: 'fields';
          readonly fields: readonly SaveProviderCredentialFieldInput[];
      };

export type ResolveProviderCredentialInput = {
    readonly provider: ModelProviderCatalogEntry;
    readonly cliCredentials: readonly AuthCredentialArg[];
    readonly apiKey: string | undefined;
    readonly existingCredential: ProviderCredential | undefined;
    readonly prompt: AuthPrompt | undefined;
    readonly promptSecret: AuthPrompt | undefined;
    readonly env?: AuthEnvironment;
};

export async function resolveProviderCredentialInput(
    input: ResolveProviderCredentialInput,
): Promise<ResolvedProviderCredential> {
    const explicitCredentials = createExplicitCredentialMap(input.provider, input.cliCredentials, input.apiKey);
    const existingCredentials = createExistingCredentialMap(input.provider, input.existingCredential);
    const environment = input.env ?? process.env;
    const fields: SaveProviderCredentialFieldInput[] = [];

    for (const field of input.provider.authFields) {
        const explicitValue = explicitCredentials.get(field.id);
        if (explicitValue !== undefined) {
            fields.push({
                id: field.id,
                value: explicitValue,
                secret: field.secret,
            });
            continue;
        }

        const envValue = resolveEnvironmentValue(field, environment);
        const existingValue = existingCredentials.get(field.id);
        const fieldPrompt = field.secret ? input.promptSecret : input.prompt;

        let value: string | undefined;
        if (fieldPrompt !== undefined) {
            value = await promptForFieldValue(field, fieldPrompt, envValue, existingValue, environment);
        } else {
            value = envValue ?? existingValue;
        }

        if (value === undefined || value.length === 0) {
            if (field.required) {
                throw new Error(`auth login requires credential ${field.id}`);
            }
            continue;
        }

        fields.push({
            id: field.id,
            value,
            secret: field.secret,
        });
    }

    if (fields.length === 0) {
        throw new Error('auth login requires credential');
    }

    const legacyApiKey = resolveLegacyApiKey(input.provider, fields);
    if (legacyApiKey !== undefined) {
        return {
            type: 'apiKey',
            apiKey: legacyApiKey,
        };
    }

    return {
        type: 'fields',
        fields,
    };
}

async function promptForFieldValue(
    field: ProviderAuthField,
    fieldPrompt: AuthPrompt,
    envValue: string | undefined,
    existingValue: string | undefined,
    environment: AuthEnvironment,
): Promise<string | undefined> {
    const defaultValue = envValue ?? existingValue;
    if (defaultValue === undefined) {
        const value = (await fieldPrompt(field.label)).trim();
        return value.length > 0 ? value : undefined;
    }

    const defaultValueSource =
        envValue !== undefined ? formatEnvironmentSource(field, environment) : 'stored credential';
    const defaultValuePreview = field.secret ? maskSecretHint(defaultValue) : defaultValue;
    const options: AuthPromptOptions = {
        defaultValue,
        defaultValuePreview,
        ...(defaultValueSource !== undefined ? { defaultValueSource } : {}),
    };
    const value = (await fieldPrompt(field.label, options)).trim();
    return value.length > 0 ? value : defaultValue;
}

function formatEnvironmentSource(field: ProviderAuthField, environment: AuthEnvironment): string | undefined {
    for (const envKey of field.env) {
        if (environment[envKey] !== undefined && environment[envKey]?.length !== 0) {
            return `${envKey} environment variable`;
        }
    }
    return undefined;
}

function createExplicitCredentialMap(
    provider: ModelProviderCatalogEntry,
    cliCredentials: readonly AuthCredentialArg[],
    apiKey: string | undefined,
): ReadonlyMap<string, string> {
    const credentials = new Map<string, string>();
    for (const credential of cliCredentials) {
        credentials.set(credential.fieldID, credential.value);
    }

    if (apiKey === undefined) {
        return credentials;
    }

    const primarySecretField = provider.authFields.find((field) => field.secret);
    if (primarySecretField === undefined) {
        throw new Error(`Provider ${provider.id} does not support --api-key`);
    }
    if (!credentials.has(primarySecretField.id)) {
        credentials.set(primarySecretField.id, apiKey.trim());
    }
    return credentials;
}

function createExistingCredentialMap(
    provider: ModelProviderCatalogEntry,
    credential: ProviderCredential | undefined,
): ReadonlyMap<string, string> {
    const credentials = new Map<string, string>();
    if (credential === undefined) {
        return credentials;
    }

    switch (credential.type) {
        case 'apiKey': {
            credentials.set('apiKey', credential.apiKey);
            const primarySecretField = provider.authFields.find((field) => field.secret);
            if (primarySecretField !== undefined) {
                credentials.set(primarySecretField.id, credential.apiKey);
            }
            return credentials;
        }
        case 'fields':
            for (const [fieldID, field] of Object.entries(credential.fields)) {
                credentials.set(fieldID, field.value);
            }
            return credentials;
        case 'oauth':
            return credentials;
        default:
            return assertNever(credential);
    }
}

function resolveEnvironmentValue(field: ProviderAuthField, env: AuthEnvironment): string | undefined {
    for (const envKey of field.env) {
        const value = env[envKey];
        if (value !== undefined && value.length > 0) {
            return value;
        }
    }
    return undefined;
}

function resolveLegacyApiKey(
    provider: ModelProviderCatalogEntry,
    fields: readonly SaveProviderCredentialFieldInput[],
): string | undefined {
    if (provider.id !== 'local') {
        return undefined;
    }
    if (fields.length !== 1) {
        return undefined;
    }
    const field = fields[0];
    if (field?.id !== 'apiKey') {
        return undefined;
    }
    return field.value;
}

function assertNever(value: never): never {
    void value;
    throw new Error('Unhandled provider credential type');
}
