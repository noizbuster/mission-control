import type { ModelProviderCatalogEntry, ProviderAuthMethod } from '@mission-control/config';
import type { SaveProviderOAuthCredentialInput } from '../auth-store.js';
import { createDefaultProviderOAuthClient } from './auth-oauth-client.js';
import { type AuthProviderPrompt, resolveProviderChoiceInput } from './auth-prompts.js';

export type ProviderOAuthLoginInput = {
    readonly providerID: string;
    readonly methodID: string;
    readonly provider: ModelProviderCatalogEntry;
    readonly method: ProviderAuthMethod;
    readonly now: string;
    readonly notify: (message: string) => void;
};

export type ProviderOAuthClient = {
    readonly login: (input: ProviderOAuthLoginInput) => Promise<SaveProviderOAuthCredentialInput>;
};

export type ResolvedAuthMethod = {
    readonly method: ProviderAuthMethod;
    readonly isExplicit: boolean;
};

export function resolveAuthMethod(
    provider: ModelProviderCatalogEntry,
    methodID: string | undefined,
): ResolvedAuthMethod {
    if (methodID === undefined) {
        return {
            method: selectApiKeyMethod(provider),
            isExplicit: false,
        };
    }

    const normalized = normalizeMethodID(methodID);
    const exact = provider.authMethods.find((method) => normalizeMethodID(method.id) === normalized);
    if (exact !== undefined) {
        return { method: exact, isExplicit: true };
    }

    const byLabel = provider.authMethods.find((method) => normalizeMethodID(method.label) === normalized);
    if (byLabel !== undefined) {
        return { method: byLabel, isExplicit: true };
    }

    if (normalized === 'oauth') {
        const oauth = provider.authMethods.find((method) => method.type === 'oauth');
        if (oauth !== undefined) {
            return { method: oauth, isExplicit: true };
        }
        throw new Error(`Provider ${provider.id} does not support OAuth login`);
    }

    if (normalized === 'api' || normalized === 'api-key' || normalized === 'apikey') {
        return { method: selectApiKeyMethod(provider), isExplicit: true };
    }

    throw new Error(
        `Unknown auth method "${methodID}" for provider ${provider.id}. Available: ${provider.authMethods
            .map((method) => method.id)
            .join(', ')}`,
    );
}

export async function resolveAuthMethodForLogin(
    provider: ModelProviderCatalogEntry,
    methodID: string | undefined,
    promptProvider: AuthProviderPrompt | undefined,
    shouldPrompt: boolean,
): Promise<ProviderAuthMethod> {
    if (methodID !== undefined) {
        return resolveAuthMethod(provider, methodID).method;
    }
    if (!shouldPrompt || promptProvider === undefined || provider.authMethods.length <= 1) {
        return selectApiKeyMethod(provider);
    }
    const choices = provider.authMethods.map((method) => ({
        id: method.id,
        name: method.label,
    }));
    const selected = await promptProvider('Select auth method', choices);
    return resolveAuthMethod(provider, resolveAuthMethodChoiceInput(selected, choices)).method;
}

export function createProviderOAuthClient(): ProviderOAuthClient {
    return createDefaultProviderOAuthClient();
}

function resolveAuthMethodChoiceInput(
    value: string,
    choices: readonly { readonly id: string; readonly name: string }[],
): string {
    try {
        const choice = resolveProviderChoiceInput(value, choices);
        if (choice.length === 0) {
            throw new Error('auth login requires --method');
        }
        return choice;
    } catch (error) {
        if (error instanceof Error && error.message === 'auth login requires --method') {
            throw error;
        }
        throw new Error('Unknown auth method selection');
    }
}

function selectApiKeyMethod(provider: ModelProviderCatalogEntry): ProviderAuthMethod {
    const method = provider.authMethods.find((entry) => entry.type === 'apiKey');
    if (method === undefined) {
        throw new Error(`Provider ${provider.id} does not support API key login`);
    }
    return method;
}

function normalizeMethodID(methodID: string): string {
    return methodID.trim().toLowerCase();
}
