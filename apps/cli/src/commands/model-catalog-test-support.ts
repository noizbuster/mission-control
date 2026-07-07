import { modelProviderCatalog } from '@mission-control/config';

export function getCatalogDefaultModelID(providerID: string): string {
    const provider = modelProviderCatalog.find((entry) => entry.id === providerID);
    if (provider === undefined) {
        throw new Error(`Expected provider in model catalog: ${providerID}`);
    }
    return provider.defaultModelID;
}
