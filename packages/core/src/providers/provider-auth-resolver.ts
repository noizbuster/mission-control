import type { ProviderAuthFile, ProviderCredential, ProviderCredentialSummary } from '@mission-control/protocol';
import type { ProviderCredentialResolveInput, ProviderCredentialResolver } from './credential-resolver.js';
import {
    ProviderCredentialResolutionError,
    redactCredentialText,
    summarizeResolvedProviderCredential,
} from './credential-resolver.js';
import { createObservabilityRedactor, type ObservabilityRedactor } from './observability-redactor.js';
import type { ProviderAuthStore } from './provider-auth-store.js';

export type ProviderAuthStoreCredentialResolverAuthStore = Pick<ProviderAuthStore, 'readAuthFile'>;

export async function redactProviderAuthStoreCredentialText(
    authStore: ProviderAuthStoreCredentialResolverAuthStore,
    text: string,
): Promise<string> {
    const authFile = await authStore.readAuthFile();
    return redactCredentialText(text, credentialSecretsFromAuthFile(authFile));
}

export async function createProviderAuthStoreObservabilityRedactor(
    authStore: ProviderAuthStoreCredentialResolverAuthStore,
): Promise<ObservabilityRedactor> {
    const authFile = await authStore.readAuthFile();
    return createObservabilityRedactor({ secrets: credentialSecretsFromAuthFile(authFile) });
}

export function createProviderAuthStoreCredentialResolver(
    authStore: ProviderAuthStoreCredentialResolverAuthStore,
): ProviderCredentialResolver {
    let cachedSecrets: readonly string[] = [];

    async function readAuthFile(): Promise<ProviderAuthFile> {
        const authFile = await authStore.readAuthFile();
        cachedSecrets = credentialSecretsFromAuthFile(authFile);
        return authFile;
    }

    async function resolveProviderCredential(
        input: ProviderCredentialResolveInput,
    ): Promise<ProviderCredential | undefined> {
        const authFile = await readAuthFile();
        return authFile.credentials[input.providerID];
    }

    return {
        resolveProviderCredential,

        async resolveRequiredProviderCredential(input) {
            const credential = await resolveProviderCredential(input);
            if (credential !== undefined) {
                return credential;
            }
            throw new ProviderCredentialResolutionError({
                providerID: input.providerID,
                code: 'credential_unavailable',
                message: `provider credential is not configured for ${input.providerID}`,
                secrets: cachedSecrets,
            });
        },

        async summarizeProviderCredential(input) {
            const credential = await resolveProviderCredential(input);
            return credential === undefined ? undefined : summarizeResolvedProviderCredential(credential);
        },

        redactForOutput(text) {
            return redactCredentialText(text, cachedSecrets);
        },
    };
}

export async function summarizeProviderCredential(
    resolver: ProviderCredentialResolver,
    input: ProviderCredentialResolveInput,
): Promise<ProviderCredentialSummary | undefined> {
    return resolver.summarizeProviderCredential(input);
}

function credentialSecretsFromAuthFile(authFile: ProviderAuthFile): readonly string[] {
    return Object.values(authFile.credentials).flatMap((credential) => credentialSecrets(credential));
}

function credentialSecrets(credential: ProviderCredential): readonly string[] {
    switch (credential.type) {
        case 'apiKey':
            return [credential.apiKey];
        case 'fields':
            return Object.values(credential.fields)
                .filter((field) => field.secret)
                .map((field) => field.value);
        case 'oauth':
            return credential.refreshToken === undefined
                ? [credential.accessToken]
                : [credential.accessToken, credential.refreshToken];
        default:
            return assertNever(credential);
    }
}

function assertNever(value: never): never {
    throw new TypeError(`Unexpected provider credential variant: ${JSON.stringify(value)}`);
}
