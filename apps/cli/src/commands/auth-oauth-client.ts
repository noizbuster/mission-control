import type { SaveProviderOAuthCredentialInput } from '../auth-store.js';
import { type BrowserOpener, openBrowserURL } from './auth-browser-opener.js';
import type { ProviderOAuthClient, ProviderOAuthLoginInput } from './auth-oauth.js';
import { waitForCallbackCode } from './auth-oauth-callback.js';
import {
    type DeviceCodeResponse,
    extractAccountLabel,
    type OAuthTokenResponse,
    parseDeviceCodeResponse,
    parseGitHubTokenPoll,
    parseOAuthTokenResponse,
    parseOpenAIHeadlessCode,
    parseOpenAIHeadlessToken,
} from './auth-oauth-client-parse.js';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

const openAIClientID = 'app_EMoamEEZ73f0CkXaXp7hrann';
const githubCopilotClientID = 'Ov23li8tweQw6odWQebz';
const openAICallbackPort = 1455;
const maxOAuthWaitMs = 5 * 60 * 1000;

export type DefaultProviderOAuthClientOptions = {
    readonly browserOpener?: BrowserOpener;
    readonly callbackPort?: number;
};

export function createDefaultProviderOAuthClient(options: DefaultProviderOAuthClientOptions = {}): ProviderOAuthClient {
    return {
        async login(input) {
            if (input.provider.id === 'openai' && input.method.id === 'oauth-browser') {
                return loginOpenAIBrowser(input, options);
            }
            if (input.provider.id === 'openai' && input.method.id === 'oauth-headless') {
                return loginOpenAIHeadless(input);
            }
            if (input.provider.id === 'github-copilot' && input.method.id === 'oauth-device') {
                return loginGitHubCopilot(input);
            }
            throw new Error(`OAuth method ${input.method.id} is not implemented for provider ${input.provider.id}`);
        },
    };
}

async function loginGitHubCopilot(input: ProviderOAuthLoginInput): Promise<SaveProviderOAuthCredentialInput> {
    const domain = process.env['MISSION_CONTROL_GITHUB_OAUTH_DOMAIN'] ?? 'github.com';
    const deviceResponse = await postJson(`https://${domain}/login/device/code`, {
        client_id: githubCopilotClientID,
        scope: 'read:user',
    });
    const device = parseDeviceCodeResponse(deviceResponse);
    input.notify(`Go to: ${device.verificationUri}`);
    input.notify(`Enter code: ${device.userCode}`);
    const token = await pollGitHubDeviceToken(domain, device);
    return {
        accessToken: token,
        refreshToken: token,
        accountLabel: domain,
    };
}

async function pollGitHubDeviceToken(domain: string, device: DeviceCodeResponse): Promise<string> {
    let delayMs = (device.interval ?? 5) * 1000;
    const deadline = Date.now() + maxOAuthWaitMs;
    while (Date.now() < deadline) {
        await sleep(delayMs);
        const pollResponse = await postJson(`https://${domain}/login/oauth/access_token`, {
            client_id: githubCopilotClientID,
            device_code: device.deviceCode,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        });
        const poll = parseGitHubTokenPoll(pollResponse);
        if (poll.accessToken !== undefined) {
            return poll.accessToken;
        }
        if (poll.error === 'authorization_pending') {
            continue;
        }
        if (poll.error === 'slow_down') {
            delayMs = (poll.interval ?? delayMs / 1000 + 5) * 1000;
            continue;
        }
        throw new Error(`GitHub Copilot OAuth failed${poll.error === undefined ? '' : `: ${poll.error}`}`);
    }
    throw new Error('GitHub Copilot OAuth timed out');
}

async function loginOpenAIHeadless(input: ProviderOAuthLoginInput): Promise<SaveProviderOAuthCredentialInput> {
    const issuer = resolveOpenAIIssuer();
    const deviceResponse = await postJson(`${issuer}/api/accounts/deviceauth/usercode`, {
        client_id: openAIClientID,
    });
    const device = parseOpenAIHeadlessCode(deviceResponse);
    input.notify(`Go to: ${issuer}/codex/device`);
    input.notify(`Enter code: ${device.userCode}`);
    const intervalMs = Math.max(Number.parseInt(device.interval ?? '', 10) || 5, 1) * 1000;
    const deadline = Date.now() + maxOAuthWaitMs;
    while (Date.now() < deadline) {
        await sleep(intervalMs);
        const response = await fetch(`${issuer}/api/accounts/deviceauth/token`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                device_auth_id: device.deviceAuthID,
                user_code: device.userCode,
            }),
        });
        if (response.status === 403 || response.status === 404) {
            continue;
        }
        if (!response.ok) {
            throw new Error(`OpenAI OAuth device polling failed: ${response.status}`);
        }
        const code = parseOpenAIHeadlessToken(await response.json());
        const tokens = await exchangeOpenAICode(issuer, {
            code: code.authorizationCode,
            codeVerifier: code.codeVerifier,
            redirectUri: `${issuer}/deviceauth/callback`,
        });
        return tokenResponseToCredential(tokens);
    }
    throw new Error('OpenAI OAuth timed out');
}

async function loginOpenAIBrowser(
    input: ProviderOAuthLoginInput,
    options: DefaultProviderOAuthClientOptions,
): Promise<SaveProviderOAuthCredentialInput> {
    const issuer = resolveOpenAIIssuer();
    const pkce = createPkce();
    const state = randomBytes(32).toString('base64url');
    const callback = await waitForCallbackCode(options.callbackPort ?? openAICallbackPort, state);
    const redirectUri = `http://localhost:${callback.port}/auth/callback`;
    const authUrl = buildOpenAIAuthorizeURL(issuer, redirectUri, pkce.challenge, state);
    input.notify(`Go to: ${authUrl}`);
    input.notify('Complete authorization in your browser.');
    await (options.browserOpener ?? openBrowserURL)(authUrl).catch(() => undefined);
    let code: string;
    try {
        code = await callback.code;
    } finally {
        await callback.close();
    }
    const tokens = await exchangeOpenAICode(issuer, {
        code,
        codeVerifier: pkce.verifier,
        redirectUri,
    });
    return tokenResponseToCredential(tokens);
}

function resolveOpenAIIssuer(): string {
    return (process.env['MISSION_CONTROL_OPENAI_OAUTH_ISSUER'] ?? 'https://auth.openai.com').replace(/\/+$/, '');
}

async function postJson(url: string, body: Readonly<Record<string, string>>): Promise<unknown> {
    const response = await fetch(url, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
    });
    if (!response.ok) {
        throw new Error(`OAuth request failed: ${response.status}`);
    }
    return response.json();
}

async function exchangeOpenAICode(
    issuer: string,
    input: { readonly code: string; readonly codeVerifier: string; readonly redirectUri: string },
): Promise<OAuthTokenResponse> {
    const response = await fetch(`${issuer}/oauth/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            grant_type: 'authorization_code',
            code: input.code,
            redirect_uri: input.redirectUri,
            client_id: openAIClientID,
            code_verifier: input.codeVerifier,
        }).toString(),
    });
    if (!response.ok) {
        throw new Error(`OpenAI OAuth token exchange failed: ${response.status}`);
    }
    return parseOAuthTokenResponse(await response.json());
}

function tokenResponseToCredential(tokens: OAuthTokenResponse): SaveProviderOAuthCredentialInput {
    const expiresAt =
        tokens.expiresIn === undefined ? undefined : new Date(Date.now() + tokens.expiresIn * 1000).toISOString();
    const accountLabel = tokens.idToken === undefined ? undefined : extractAccountLabel(tokens.idToken);
    return {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken ?? tokens.accessToken,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        ...(accountLabel !== undefined ? { accountLabel } : {}),
    };
}

function createPkce(): { readonly verifier: string; readonly challenge: string } {
    const verifier = randomBytes(32).toString('base64url');
    const challenge = createHash('sha256').update(verifier).digest('base64url');
    return { verifier, challenge };
}

function buildOpenAIAuthorizeURL(issuer: string, redirectUri: string, challenge: string, state: string): string {
    const params = new URLSearchParams({
        response_type: 'code',
        client_id: openAIClientID,
        redirect_uri: redirectUri,
        scope: 'openid profile email offline_access',
        code_challenge: challenge,
        code_challenge_method: 'S256',
        id_token_add_organizations: 'true',
        codex_cli_simplified_flow: 'true',
        state,
        originator: 'mission-control',
    });
    return `${issuer}/oauth/authorize?${params.toString()}`;
}
