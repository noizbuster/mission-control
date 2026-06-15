import { modelProviderCatalog } from '@mission-control/config';
import type { CliArgs } from '../args.js';
import { createProviderAuthStore, type ProviderAuthStore } from '../auth-store.js';
import { createDefaultModelDiscovery, type ModelDiscovery } from './model-discovery.js';
import { formatProviderCapabilityStatus } from './model-capability.js';

export type ModelsCommandOptions = {
    readonly store?: ProviderAuthStore;
    readonly modelDiscovery?: ModelDiscovery;
};

export async function runModelsCommand(args: CliArgs, options: ModelsCommandOptions = {}): Promise<string> {
    const store = options.store ?? createProviderAuthStore();
    const discovery = options.modelDiscovery ?? createDefaultModelDiscovery();
    const summaries = await store.listCredentialSummaries();
    const authenticatedProviderIDs = new Set(summaries.map((summary) => summary.providerID));
    const authFile = await store.readAuthFile();
    const providers = selectProviders(args.modelsProviderID, authenticatedProviderIDs);
    const lines: string[] = ['Models'];

    for (const provider of providers) {
        const credential = authFile.credentials[provider.id];
        const catalogModelIDs = provider.models.map((model) => model.id);
        const isExecutable = provider.capability.status === 'executable';
        const statusSuffix = isExecutable ? '' : ` (${formatProviderCapabilityStatus(provider)})`;

        let apiModelIDs: readonly string[] | undefined;
        if (credential !== undefined) {
            apiModelIDs = await discovery({ provider, credential });
        }

        const modelIDs = apiModelIDs ?? catalogModelIDs;
        const extras = apiModelIDs !== undefined
            ? catalogModelIDs.filter((id) => !apiModelIDs!.includes(id))
            : [];
        for (const id of [...modelIDs, ...extras]) {
            lines.push(`  ${provider.id}/${id}${extras.includes(id) ? ' (catalog only)' : ''}${statusSuffix}`);
        }
    }

    return `${lines.join('\n')}\n`;
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
