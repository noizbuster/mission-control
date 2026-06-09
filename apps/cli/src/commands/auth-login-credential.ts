import type { ModelProviderCatalogEntry } from '@mission-control/config';
import type { ModelProviderSelection, ProviderCredential } from '@mission-control/protocol';
import type { CliArgs } from '../args.js';
import type { ProviderAuthStore } from '../auth-store.js';
import { resolveProviderCredentialInput } from './auth-credential-resolution.js';
import type { AuthPrompt } from './auth-prompts.js';

export type SaveApiCredentialOptions = {
    readonly store: ProviderAuthStore;
    readonly selection: ModelProviderSelection;
    readonly provider: ModelProviderCatalogEntry;
    readonly existingCredential: ProviderCredential | undefined;
    readonly prompt: AuthPrompt | undefined;
    readonly promptSecret: AuthPrompt | undefined;
    readonly now: string;
};

export async function saveApiCredential(args: CliArgs, options: SaveApiCredentialOptions): Promise<void> {
    const credential = await resolveProviderCredentialInput({
        provider: options.provider,
        cliCredentials: args.authCredentials ?? [],
        apiKey: args.authApiKey,
        existingCredential: options.existingCredential,
        prompt: options.prompt,
        promptSecret: options.promptSecret,
    });
    if (credential.type === 'apiKey') {
        await options.store.saveCredential({
            providerID: options.selection.providerID,
            modelID: options.selection.modelID,
            apiKey: credential.apiKey,
            now: options.now,
        });
        return;
    }
    await options.store.saveCredential({
        providerID: options.selection.providerID,
        modelID: options.selection.modelID,
        fields: credential.fields,
        now: options.now,
    });
}

export function rejectOAuthCredentialFlags(args: CliArgs): void {
    if (args.authApiKey !== undefined) {
        throw new Error('auth login --method oauth cannot be combined with --api-key');
    }
    if ((args.authCredentials ?? []).length > 0) {
        throw new Error('auth login --method oauth cannot be combined with --credential');
    }
}
