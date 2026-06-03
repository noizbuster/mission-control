import { modelProviderCatalog } from '@mission-control/config';
import type { CliArgs } from '../args.js';
import { createProviderAuthStore, type ProviderAuthStore } from '../auth-store.js';

export type ModelsCommandOptions = {
    readonly store?: ProviderAuthStore;
};

export async function runModelsCommand(args: CliArgs, options: ModelsCommandOptions = {}): Promise<string> {
    const providers = selectProviders(args.modelsProviderID);
    const store = options.store ?? createProviderAuthStore();
    const summaries = await store.listCredentialSummaries();
    const authenticatedProviderIDs = new Set(summaries.map((summary) => summary.providerID));
    const lines = providers.flatMap((provider) =>
        provider.models.map((model) => {
            const status = authenticatedProviderIDs.has(provider.id) ? 'authenticated' : 'missing credential';
            return `${provider.id}/${model.id} ${status}`;
        }),
    );
    return ['Models', ...lines, ''].join('\n');
}

function selectProviders(providerID: string | undefined): readonly (typeof modelProviderCatalog)[number][] {
    if (providerID === undefined) {
        return modelProviderCatalog;
    }
    const provider = modelProviderCatalog.find((entry) => entry.id === providerID);
    if (provider === undefined) {
        throw new Error(`Unknown provider: ${providerID}`);
    }
    return [provider];
}
