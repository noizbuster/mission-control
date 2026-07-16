import type { ProviderOAuthCredential } from '@mission-control/protocol';
import { describe, expect, it, vi } from 'vitest';
import { createStaticProviderCredentialResolver } from './credential-resolver';
import {
    createOAuthRefreshingCredentialResolver,
    oauthCredentialNeedsRefresh,
} from './oauth-credential-refresh';

const baseOAuth: ProviderOAuthCredential = {
    providerID: 'xai',
    type: 'oauth',
    accessToken: 'expired-access',
    refreshToken: 'refresh-token',
    expiresAt: '2026-07-16T09:00:00.000Z',
    createdAt: '2026-07-16T08:00:00.000Z',
    updatedAt: '2026-07-16T08:00:00.000Z',
    accountLabel: 'user@example.com',
};

describe('oauthCredentialNeedsRefresh', () => {
    it('returns true when expiresAt is within the skew window', () => {
        // Given
        const nowMs = Date.parse('2026-07-16T10:00:00.000Z');
        // When / Then
        expect(oauthCredentialNeedsRefresh(baseOAuth, nowMs, 120_000)).toBe(true);
    });

    it('returns false when expiresAt is beyond the skew window', () => {
        // Given
        const future = {
            ...baseOAuth,
            expiresAt: '2026-07-16T12:00:00.000Z',
        };
        const nowMs = Date.parse('2026-07-16T10:00:00.000Z');
        // When / Then
        expect(oauthCredentialNeedsRefresh(future, nowMs, 120_000)).toBe(false);
    });

    it('returns false when refreshToken is missing', () => {
        // Given
        const noRefresh = { ...baseOAuth, refreshToken: undefined };
        // When / Then
        expect(oauthCredentialNeedsRefresh(noRefresh, Date.parse('2026-07-16T12:00:00.000Z'))).toBe(false);
    });
});

describe('createOAuthRefreshingCredentialResolver', () => {
    it('refreshes and persists an expired OAuth credential before resolve', async () => {
        // Given
        const base = createStaticProviderCredentialResolver([baseOAuth]);
        const persistOAuth = vi.fn(async () => undefined);
        const refresher = vi.fn(async () => ({
            accessToken: 'fresh-access',
            refreshToken: 'fresh-refresh',
            expiresAt: '2026-07-16T18:00:00.000Z',
        }));
        const resolver = createOAuthRefreshingCredentialResolver({
            base,
            persistOAuth,
            refreshers: { xai: refresher },
            nowMs: () => Date.parse('2026-07-16T12:00:00.000Z'),
        });

        // When
        const credential = await resolver.resolveProviderCredential({ providerID: 'xai' });

        // Then
        expect(refresher).toHaveBeenCalledOnce();
        expect(persistOAuth).toHaveBeenCalledWith('xai', {
            accessToken: 'fresh-access',
            refreshToken: 'fresh-refresh',
            expiresAt: '2026-07-16T18:00:00.000Z',
        });
        expect(credential).toMatchObject({
            providerID: 'xai',
            type: 'oauth',
            accessToken: 'fresh-access',
            refreshToken: 'fresh-refresh',
            expiresAt: '2026-07-16T18:00:00.000Z',
            accountLabel: 'user@example.com',
        });
    });

    it('does not refresh a still-valid OAuth credential', async () => {
        // Given
        const valid = {
            ...baseOAuth,
            accessToken: 'valid-access',
            expiresAt: '2026-07-16T18:00:00.000Z',
        };
        const base = createStaticProviderCredentialResolver([valid]);
        const persistOAuth = vi.fn(async () => undefined);
        const refresher = vi.fn(async () => ({
            accessToken: 'should-not-use',
        }));
        const resolver = createOAuthRefreshingCredentialResolver({
            base,
            persistOAuth,
            refreshers: { xai: refresher },
            nowMs: () => Date.parse('2026-07-16T12:00:00.000Z'),
        });

        // When
        const credential = await resolver.resolveProviderCredential({ providerID: 'xai' });

        // Then
        expect(refresher).not.toHaveBeenCalled();
        expect(persistOAuth).not.toHaveBeenCalled();
        expect(credential).toMatchObject({ accessToken: 'valid-access' });
    });

    it('coalesces concurrent refresh calls for the same provider', async () => {
        // Given
        const base = createStaticProviderCredentialResolver([baseOAuth]);
        let releaseRefresh: ((value: {
            readonly accessToken: string;
            readonly refreshToken: string;
            readonly expiresAt: string;
        }) => void) | undefined;
        const refreshGate = new Promise<{
            readonly accessToken: string;
            readonly refreshToken: string;
            readonly expiresAt: string;
        }>((resolve) => {
            releaseRefresh = resolve;
        });
        const refresher = vi.fn(async () => refreshGate);
        const persistOAuth = vi.fn(async () => undefined);
        const resolver = createOAuthRefreshingCredentialResolver({
            base,
            persistOAuth,
            refreshers: { xai: refresher },
            nowMs: () => Date.parse('2026-07-16T12:00:00.000Z'),
        });

        // When
        const first = resolver.resolveProviderCredential({ providerID: 'xai' });
        const second = resolver.resolveProviderCredential({ providerID: 'xai' });
        await Promise.resolve();
        if (releaseRefresh === undefined) {
            throw new Error('refresh gate was not armed');
        }
        releaseRefresh({
            accessToken: 'fresh-access',
            refreshToken: 'fresh-refresh',
            expiresAt: '2026-07-16T18:00:00.000Z',
        });
        const [a, b] = await Promise.all([first, second]);

        // Then
        expect(refresher).toHaveBeenCalledOnce();
        expect(persistOAuth).toHaveBeenCalledOnce();
        expect(a).toMatchObject({ accessToken: 'fresh-access' });
        expect(b).toMatchObject({ accessToken: 'fresh-access' });
    });
});
