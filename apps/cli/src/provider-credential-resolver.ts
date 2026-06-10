import type { ProviderCredentialResolveInput, ProviderCredentialResolver } from '@mission-control/core';
import {
    ProviderCredentialResolutionError,
    redactCredentialText,
    summarizeResolvedProviderCredential,
} from '@mission-control/core';
import type { ProviderAuthFile, ProviderCredential, ProviderCredentialSummary } from '@mission-control/protocol';
import type { ProviderAuthStore } from './auth-store.js';

export type CliProviderCredentialResolverAuthStore = Pick<ProviderAuthStore, 'readAuthFile'>;

export function createCliProviderCredentialResolver(
    authStore: CliProviderCredentialResolverAuthStore,
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

export async function summarizeCliProviderCredential(
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
