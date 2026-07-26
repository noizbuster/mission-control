import type { ModelProviderCatalogEntry } from '@mission-control/config';

/**
 * Looks a provider up in a model-provider catalog by id and throws a uniform
 * `Unknown provider: <id>` error when it is absent.
 *
 * Only the find + throw is shared here; every caller applies its own follow-up
 * logic (model lookup, capability checks, status display, …) on the returned
 * entry, so this intentionally does no further validation.
 */
export function findProviderOrThrow(
    catalog: readonly ModelProviderCatalogEntry[],
    providerID: string,
): ModelProviderCatalogEntry {
    const provider = catalog.find((entry) => entry.id === providerID);
    if (provider === undefined) {
        throw new Error(`Unknown provider: ${providerID}`);
    }
    return provider;
}
