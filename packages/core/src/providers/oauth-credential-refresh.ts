import type { ProviderCredential, ProviderOAuthCredential } from '@mission-control/protocol';
import type { ProviderCredentialResolveInput, ProviderCredentialResolver } from './credential-resolver';
import {
    ProviderCredentialResolutionError,
    summarizeResolvedProviderCredential,
} from './credential-resolver';
import type { SaveProviderOAuthCredentialInput } from './provider-auth-store';

export const DEFAULT_OAUTH_REFRESH_SKEW_MS = 120_000;

export type OAuthTokenRefresher = (
    credential: ProviderOAuthCredential,
) => Promise<SaveProviderOAuthCredentialInput>;

export type OAuthCredentialPersist = (
    providerID: string,
    oauth: SaveProviderOAuthCredentialInput,
) => Promise<void>;

export type CreateOAuthRefreshingCredentialResolverInput = {
    readonly base: ProviderCredentialResolver;
    readonly refreshers: Readonly<Record<string, OAuthTokenRefresher>>;
    readonly persistOAuth: OAuthCredentialPersist;
    readonly skewMs?: number;
    readonly nowMs?: () => number;
};

export function oauthCredentialNeedsRefresh(
    credential: ProviderOAuthCredential,
    nowMs: number,
    skewMs = DEFAULT_OAUTH_REFRESH_SKEW_MS,
): boolean {
    if (credential.refreshToken === undefined || credential.refreshToken.length === 0) {
        return false;
    }
    if (credential.expiresAt === undefined) {
        return false;
    }
    const expiresAtMs = Date.parse(credential.expiresAt);
    if (Number.isNaN(expiresAtMs)) {
        return true;
    }
    return expiresAtMs <= nowMs + skewMs;
}

export function createOAuthRefreshingCredentialResolver(
    input: CreateOAuthRefreshingCredentialResolverInput,
): ProviderCredentialResolver {
    const skewMs = input.skewMs ?? DEFAULT_OAUTH_REFRESH_SKEW_MS;
    const nowMs = input.nowMs ?? (() => Date.now());
    const inFlight = new Map<string, Promise<ProviderCredential | undefined>>();

    async function resolveMaybeRefreshed(
        resolveInput: ProviderCredentialResolveInput,
    ): Promise<ProviderCredential | undefined> {
        const pending = inFlight.get(resolveInput.providerID);
        if (pending !== undefined) {
            return pending;
        }
        const work = (async () => {
            const credential = await input.base.resolveProviderCredential(resolveInput);
            if (credential === undefined || credential.type !== 'oauth') {
                return credential;
            }
            const refresher = input.refreshers[resolveInput.providerID];
            if (refresher === undefined || !oauthCredentialNeedsRefresh(credential, nowMs(), skewMs)) {
                return credential;
            }
            const refreshed = await refresher(credential);
            await input.persistOAuth(resolveInput.providerID, refreshed);
            return {
                ...credential,
                accessToken: refreshed.accessToken,
                updatedAt: new Date(nowMs()).toISOString(),
                ...(refreshed.refreshToken !== undefined
                    ? { refreshToken: refreshed.refreshToken }
                    : credential.refreshToken !== undefined
                      ? { refreshToken: credential.refreshToken }
                      : {}),
                ...(refreshed.expiresAt !== undefined
                    ? { expiresAt: refreshed.expiresAt }
                    : credential.expiresAt !== undefined
                      ? { expiresAt: credential.expiresAt }
                      : {}),
                ...(refreshed.accountLabel !== undefined
                    ? { accountLabel: refreshed.accountLabel }
                    : credential.accountLabel !== undefined
                      ? { accountLabel: credential.accountLabel }
                      : {}),
                ...(refreshed.scopes !== undefined
                    ? { scopes: [...refreshed.scopes] }
                    : credential.scopes !== undefined
                      ? { scopes: [...credential.scopes] }
                      : {}),
            } satisfies ProviderOAuthCredential;
        })();
        inFlight.set(resolveInput.providerID, work);
        try {
            return await work;
        } finally {
            inFlight.delete(resolveInput.providerID);
        }
    }

    return {
        resolveProviderCredential: resolveMaybeRefreshed,

        async resolveRequiredProviderCredential(resolveInput) {
            const credential = await resolveMaybeRefreshed(resolveInput);
            if (credential !== undefined) {
                return credential;
            }
            throw new ProviderCredentialResolutionError({
                providerID: resolveInput.providerID,
                code: 'credential_unavailable',
                message: `provider credential is not configured for ${resolveInput.providerID}`,
            });
        },

        async summarizeProviderCredential(resolveInput) {
            const credential = await resolveMaybeRefreshed(resolveInput);
            return credential === undefined ? undefined : summarizeResolvedProviderCredential(credential);
        },

        redactForOutput(text) {
            return input.base.redactForOutput(text);
        },
    };
}
