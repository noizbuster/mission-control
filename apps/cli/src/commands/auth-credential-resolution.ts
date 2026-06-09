import type { ModelProviderCatalogEntry, ProviderAuthField } from '@mission-control/config';
import type { ProviderCredential } from '@mission-control/protocol';
import type { AuthCredentialArg } from '../args.js';
import type { SaveProviderCredentialFieldInput } from '../auth-store.js';
import type { AuthPrompt } from './auth-prompts.js';

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
        const value =
            explicitCredentials.get(field.id) ??
            resolveEnvironmentValue(field, environment) ??
            existingCredentials.get(field.id) ??
            (await resolvePromptedFieldValue(field, input.prompt, input.promptSecret));

        if (value === undefined) {
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

async function resolvePromptedFieldValue(
    field: ProviderAuthField,
    prompt: AuthPrompt | undefined,
    promptSecret: AuthPrompt | undefined,
): Promise<string | undefined> {
    const fieldPrompt = field.secret ? promptSecret : prompt;
    if (fieldPrompt === undefined) {
        return undefined;
    }
    const value = (await fieldPrompt(field.label)).trim();
    return value.length > 0 ? value : undefined;
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
