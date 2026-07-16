import {
    createOAuthRefreshingCredentialResolver,
    createProviderAuthStoreCredentialResolver,
    type ProviderAuthStore,
    type ProviderCredentialResolver,
    type SaveProviderOAuthCredentialInput,
    summarizeProviderCredential as summarizeCliProviderCredential,
} from '@mission-control/core';
import type { ProviderOAuthCredential } from '@mission-control/protocol';
import { refreshXaiOAuthCredential } from './commands/auth-oauth-client';

export { summarizeCliProviderCredential };

export type CliProviderCredentialResolverAuthStore = Pick<ProviderAuthStore, 'readAuthFile'> &
    Partial<Pick<ProviderAuthStore, 'updateOAuthCredential'>>;

export function createCliProviderCredentialResolver(
    authStore: CliProviderCredentialResolverAuthStore,
): ProviderCredentialResolver {
    const base = createProviderAuthStoreCredentialResolver(authStore);
    const updateOAuthCredential = authStore.updateOAuthCredential;
    if (updateOAuthCredential === undefined) {
        return base;
    }
    return createOAuthRefreshingCredentialResolver({
        base,
        persistOAuth: (providerID, oauth) => updateOAuthCredential(providerID, oauth),
        refreshers: {
            xai: refreshXaiCredential,
        },
    });
}

async function refreshXaiCredential(
    credential: ProviderOAuthCredential,
): Promise<SaveProviderOAuthCredentialInput> {
    if (credential.refreshToken === undefined || credential.refreshToken.length === 0) {
        throw new Error('xAI OAuth refresh token is unavailable');
    }
    return refreshXaiOAuthCredential({ refreshToken: credential.refreshToken });
}
