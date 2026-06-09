import { modelProviderCatalog } from '@mission-control/config';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDefaultProviderOAuthClient } from './auth-oauth-client.js';
import { createServer, type Server } from 'node:http';

type FakeIssuer = {
    readonly origin: string;
    readonly close: () => Promise<void>;
};

describe('createDefaultProviderOAuthClient', () => {
    afterEach(() => {
        vi.unstubAllEnvs();
    });

    it('opens the browser authorization URL for OpenAI browser OAuth login', async () => {
        const issuer = await createFakeOpenAIIssuer();
        vi.stubEnv('MISSION_CONTROL_OPENAI_OAUTH_ISSUER', issuer.origin);
        const provider = findOpenAIProvider();
        const method = findOpenAIBrowserMethod();
        const openedURLs: string[] = [];
        let resolveAuthURL: (url: URL) => void = () => undefined;
        const authURL = new Promise<URL>((resolve) => {
            resolveAuthURL = resolve;
        });

        try {
            const client = createDefaultProviderOAuthClient({
                browserOpener: async (url) => {
                    openedURLs.push(url);
                },
                callbackPort: 0,
            });
            const login = client.login({
                providerID: provider.id,
                methodID: method.id,
                provider,
                method,
                now: '2026-06-03T10:00:00.000Z',
                notify: (message) => {
                    if (message.startsWith('Go to: ')) {
                        resolveAuthURL(new URL(message.slice('Go to: '.length)));
                    }
                },
            });
            const url = await authURL;
            await fetchCallback(url);
            const credential = await login;

            expect(openedURLs).toEqual([url.href]);
            expect(credential).toMatchObject({
                accessToken: 'openai_access_token',
                refreshToken: 'openai_refresh_token',
                accountLabel: 'chatgpt@example.com',
            });
        } finally {
            await issuer.close();
        }
    });
});

function findOpenAIProvider() {
    const provider = modelProviderCatalog.find((entry) => entry.id === 'openai');
    if (provider === undefined) {
        throw new Error('OpenAI provider is missing from test catalog');
    }
    return provider;
}

function findOpenAIBrowserMethod() {
    const provider = findOpenAIProvider();
    const method = provider.authMethods.find((entry) => entry.id === 'oauth-browser');
    if (method === undefined) {
        throw new Error('OpenAI browser OAuth method is missing from test catalog');
    }
    return method;
}

async function createFakeOpenAIIssuer(): Promise<FakeIssuer> {
    const idToken = [
        'unused',
        Buffer.from(JSON.stringify({ email: 'chatgpt@example.com' })).toString('base64url'),
        'sig',
    ].join('.');
    const server = createServer((request, response) => {
        if (request.url === '/oauth/token') {
            response.writeHead(200, { 'content-type': 'application/json' });
            response.end(
                JSON.stringify({
                    access_token: 'openai_access_token',
                    refresh_token: 'openai_refresh_token',
                    expires_in: 3600,
                    id_token: idToken,
                }),
            );
            return;
        }
        response.writeHead(404);
        response.end('not found');
    });
    await listen(server);
    const address = server.address();
    if (typeof address !== 'object' || address === null) {
        throw new Error('Fake OpenAI issuer did not bind to a TCP port');
    }
    return {
        origin: `http://127.0.0.1:${address.port}`,
        close: () => closeServer(server),
    };
}

async function fetchCallback(authURL: URL): Promise<void> {
    const redirectURI = authURL.searchParams.get('redirect_uri');
    const state = authURL.searchParams.get('state');
    if (redirectURI === null || state === null) {
        throw new Error('OpenAI browser OAuth URL is missing callback parameters');
    }
    const callbackURL = new URL(redirectURI);
    callbackURL.searchParams.set('code', 'test_auth_code');
    callbackURL.searchParams.set('state', state);
    const response = await fetch(callbackURL);
    expect(response.status).toBe(200);
}

function listen(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
}

function closeServer(server: Server): Promise<void> {
    return new Promise((resolve, reject) => {
        server.close((error) => {
            if (error !== undefined) {
                reject(error);
                return;
            }
            resolve();
        });
    });
}
