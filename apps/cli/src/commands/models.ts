import { modelProviderCatalog } from '@mission-control/config';
import type { CliArgs } from '../args.js';
import { createProviderAuthStore, type ProviderAuthStore } from '../auth-store.js';
import { formatProviderCapabilityStatus } from './model-capability.js';

export type ModelsCommandOptions = {
    readonly store?: ProviderAuthStore;
};

export async function runModelsCommand(args: CliArgs, options: ModelsCommandOptions = {}): Promise<string> {
    const store = options.store ?? createProviderAuthStore();
    const summaries = await store.listCredentialSummaries();
    const authenticatedProviderIDs = new Set(summaries.map((summary) => summary.providerID));
    const providers = selectProviders(args.modelsProviderID, authenticatedProviderIDs);
    const lines = providers.flatMap((provider) =>
        provider.models.map((model) => {
            const status = authenticatedProviderIDs.has(provider.id) ? 'authenticated' : 'missing credential';
            return `${provider.id}/${model.id} ${status} ${formatProviderCapabilityStatus(provider)}`;
        }),
    );
    return ['Models', ...lines, ''].join('\n');
}

function selectProviders(
    providerID: string | undefined,
    authenticatedProviderIDs: Set<string>,
): readonly (typeof modelProviderCatalog)[number][] {
    if (providerID !== undefined) {
        const provider = modelProviderCatalog.find((entry) => entry.id === providerID);
        if (provider === undefined) {
            throw new Error(`Unknown provider: ${providerID}`);
        }
        return [provider];
    }
    return modelProviderCatalog.filter((entry) => authenticatedProviderIDs.has(entry.id));
}
