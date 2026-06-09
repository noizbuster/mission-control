import { modelProviderCatalog } from '@mission-control/config';
import type { ModelProviderSelection, ProviderCredentialSummary } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import { createProviderAuthStore, type ProviderAuthStore } from '../auth-store.js';
import { rejectOAuthCredentialFlags, saveApiCredential } from './auth-login-credential.js';
import { createProviderOAuthClient, type ProviderOAuthClient, resolveAuthMethodForLogin } from './auth-oauth.js';
import {
    type AuthPrompt,
    type AuthPromptSession,
    type AuthProviderPrompt,
    createPromptSession,
    isPromptInputTTY,
    type ProviderPromptChoice,
    resolveProviderChoiceInput,
} from './auth-prompts.js';

export type AuthCommandOptions = {
    readonly store?: ProviderAuthStore;
    readonly now?: string;
    readonly prompt?: AuthPrompt;
    readonly promptSecret?: AuthPrompt;
    readonly promptProvider?: AuthProviderPrompt;
    readonly createPromptSession?: () => AuthPromptSession;
    readonly oauthClient?: ProviderOAuthClient;
};

export async function runAuthCommand(args: CliArgs, options: AuthCommandOptions = {}): Promise<string> {
    switch (args.command) {
        case 'auth-login':
            return runAuthLogin(args, options);
        case 'auth-list':
            return runAuthList(options.store ?? createProviderAuthStore());
        case 'auth-logout':
            return runAuthLogout(args, options);
        default:
            throw new Error(`Unsupported auth command: ${args.command}`);
    }
}

async function runAuthLogin(args: CliArgs, options: AuthCommandOptions): Promise<string> {
    const promptSession =
        options.prompt === undefined && options.promptSecret === undefined && shouldCreatePromptSession(args, options)
            ? (options.createPromptSession ?? createPromptSession)()
            : undefined;
    const prompt = options.prompt ?? promptSession?.prompt;
    const promptSecret = options.promptSecret ?? options.prompt ?? promptSession?.promptSecret;
    const promptProvider =
        options.promptProvider ??
        promptSession?.promptProvider ??
        (options.prompt !== undefined ? createProviderPromptFallback(options.prompt) : undefined);

    try {
        const providerID = await resolveProviderID(args.authProviderID, promptProvider);
        if (providerID.length === 0) {
            throw new Error('auth login requires --provider');
        }

        const provider = modelProviderCatalog.find((entry) => entry.id === providerID);
        if (provider === undefined) {
            throw new Error(`Unknown provider: ${providerID}`);
        }

        const modelID = args.authModelID ?? provider.defaultModelID;
        const selection = validateProviderModelSelection({
            providerID: provider.id,
            modelID,
        });

        const shouldPromptAuthMethod =
            args.authMethodID === undefined &&
            args.authApiKey === undefined &&
            (args.authCredentials ?? []).length === 0;
        const method = await resolveAuthMethodForLogin(
            provider,
            args.authMethodID,
            promptProvider,
            shouldPromptAuthMethod,
        );
        const now = options.now ?? new Date().toISOString();
        const store = options.store ?? createProviderAuthStore();
        const authFile = await store.readAuthFile();
        const notices: string[] = [];
        if (method.type === 'oauth') {
            rejectOAuthCredentialFlags(args);
            const oauth = await (options.oauthClient ?? createProviderOAuthClient()).login({
                providerID: provider.id,
                methodID: method.id,
                provider,
                method,
                now,
                notify: (message) => notices.push(message),
            });
            await store.saveCredential({
                providerID: selection.providerID,
                modelID: selection.modelID,
                oauth,
                now,
            });
        } else {
            await saveApiCredential(args, {
                store,
                selection,
                provider,
                existingCredential: authFile.credentials[provider.id],
                prompt,
                promptSecret,
                now,
            });
        }
        const summary = (await store.listCredentialSummaries()).find(
            (entry) => entry.providerID === selection.providerID,
        );
        const maskedCredential = summary?.maskedCredential ?? '********';
        return [
            ...notices,
            `Logged in ${selection.providerID}`,
            `default: ${selection.providerID}/${selection.modelID}`,
            `credential: ${maskedCredential}`,
            '',
        ].join('\n');
    } finally {
        promptSession?.close();
    }
}

function createProviderPromptFallback(prompt: AuthPrompt): AuthProviderPrompt {
    return async (message) => prompt(message);
}

function shouldCreatePromptSession(args: CliArgs, options: AuthCommandOptions): boolean {
    if (options.createPromptSession !== undefined) {
        return true;
    }
    if (args.authProviderID === undefined) {
        return true;
    }
    if (args.authApiKey === undefined && (args.authCredentials ?? []).length === 0) {
        return true;
    }
    return isPromptInputTTY();
}

async function resolveProviderID(
    value: string | undefined,
    promptProvider: AuthProviderPrompt | undefined,
): Promise<string> {
    if (value !== undefined) {
        return value.trim();
    }
    if (promptProvider === undefined) {
        throw new Error('auth login requires --provider');
    }
    const choices = modelProviderCatalog.map((provider) => ({
        id: provider.id,
        name: provider.name,
    }));
    return resolveProviderChoiceInput(await promptProvider('Select provider', choices), choices);
}

async function runAuthList(store: ProviderAuthStore): Promise<string> {
    const summaries = await listConfiguredCredentialSummaries(store);
    const choices = await createConfiguredProviderChoices(summaries, store);
    const lines = choices.map((choice) => `${choice.id} ${choice.name}`);
    if (lines.length === 0) {
        return 'No provider credentials configured\n';
    }
    return ['Authenticated providers', ...lines, ''].join('\n');
}

async function runAuthLogout(args: CliArgs, options: AuthCommandOptions): Promise<string> {
    const store = options.store ?? createProviderAuthStore();
    let promptSession: AuthPromptSession | undefined;

    try {
        const summaries = await listConfiguredCredentialSummaries(store);
        if (args.authProviderID === undefined && summaries.length === 0) {
            return 'No provider credentials configured\n';
        }
        promptSession =
            args.authProviderID === undefined && options.promptProvider === undefined && options.prompt === undefined
                ? (options.createPromptSession ?? createPromptSession)()
                : undefined;
        const promptProvider =
            options.promptProvider ??
            promptSession?.promptProvider ??
            (options.prompt !== undefined ? createProviderPromptFallback(options.prompt) : undefined);
        const providerID = await resolveLogoutProviderID(args.authProviderID, summaries, store, promptProvider);
        if (providerID.length === 0) {
            throw new Error('auth logout requires --provider');
        }
        validateProviderID(providerID);
        if (!summaries.some((summary) => summary.providerID === providerID)) {
            throw new Error(`Provider credential not configured: ${providerID}`);
        }
        await store.deleteCredential(providerID);
        return `Logged out ${providerID}\n`;
    } finally {
        promptSession?.close();
    }
}

async function resolveLogoutProviderID(
    value: string | undefined,
    summaries: readonly ProviderCredentialSummary[],
    store: ProviderAuthStore,
    promptProvider: AuthProviderPrompt | undefined,
): Promise<string> {
    if (value !== undefined) {
        return value.trim();
    }
    if (promptProvider === undefined) {
        throw new Error('auth logout requires --provider');
    }
    const choices = await createConfiguredProviderChoices(summaries, store);
    return resolveProviderChoiceInput(await promptProvider('Select provider to log out', choices), choices);
}

async function createConfiguredProviderChoices(
    summaries: readonly ProviderCredentialSummary[],
    store: ProviderAuthStore,
): Promise<readonly ProviderPromptChoice[]> {
    const defaultSelection = await store.getDefaultSelection();
    return summaries.map((summary) => {
        return {
            id: summary.providerID,
            name: formatConfiguredProviderLabel(summary, defaultSelection),
        };
    });
}

function formatConfiguredProviderLabel(
    summary: ProviderCredentialSummary,
    defaultSelection: ModelProviderSelection | undefined,
): string {
    const provider = modelProviderCatalog.find((entry) => entry.id === summary.providerID);
    const defaultLabel =
        defaultSelection?.providerID === summary.providerID
            ? ` - default ${summary.providerID}/${defaultSelection.modelID}`
            : '';
    return `${provider?.name ?? summary.providerID} - ${summary.maskedCredential ?? '********'}${defaultLabel}`;
}

async function listConfiguredCredentialSummaries(
    store: ProviderAuthStore,
): Promise<readonly ProviderCredentialSummary[]> {
    const summaries = await store.listCredentialSummaries();
    const summaryByProvider = new Map(summaries.map((summary) => [summary.providerID, summary]));
    return modelProviderCatalog.map((provider) => summaryByProvider.get(provider.id)).filter(isDefined);
}

function validateProviderID(providerID: string): void {
    if (!modelProviderCatalog.some((entry) => entry.id === providerID)) {
        throw new Error(`Unknown provider: ${providerID}`);
    }
}

function validateProviderModelSelection(selection: ModelProviderSelection): ModelProviderSelection {
    const provider = modelProviderCatalog.find((entry) => entry.id === selection.providerID);
    if (provider === undefined) {
        throw new Error(`Unknown provider: ${selection.providerID}`);
    }
    if (!provider.models.some((model) => model.id === selection.modelID)) {
        throw new Error(`Model ${selection.modelID} is not available for provider ${selection.providerID}`);
    }
    return selection;
}

function isDefined<T>(value: T | undefined): value is T {
    return value !== undefined;
}
