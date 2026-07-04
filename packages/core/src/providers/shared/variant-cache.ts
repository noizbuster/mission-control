import type { ModelProviderCatalogEntry } from '@mission-control/config';

/**
 * Predicate over `(providerID, modelID, variantID)` that reports whether a
 * variant is configured for a model in the catalog. Output-equivalent to the
 * per-provider linear scans it replaces.
 */
export type VariantLookup = (providerID: string, modelID: string, variantID: string) => boolean;

/**
 * Builds a memoized {@link VariantLookup} over the given catalog.
 *
 * The backing index is a `Map<providerID, Map<modelID, Set<variantID>>>`.
 * Each provider's entry is built LAZILY on the first lookup for that
 * providerID via a single `catalog.find`, so a spy installed before the first
 * call records exactly one scan per provider and zero on every subsequent
 * lookup. The catalog is a vendored static snapshot and is never mutated at
 * runtime, so the cache needs no invalidation.
 *
 * NOTE: building at module top-level would run before any test spy is
 * installed and hide the scan (false-positive memoization). The per-provider
 * lazy build keeps the first `catalog.find` inside the spy window.
 */
export function createVariantLookup(catalog: readonly ModelProviderCatalogEntry[]): VariantLookup {
    let byProvider: Map<string, Map<string, Set<string>>> | undefined;

    return (providerID: string, modelID: string, variantID: string): boolean => {
        byProvider ??= new Map();
        let modelMap = byProvider.get(providerID);
        if (modelMap === undefined) {
            const provider = catalog.find((entry) => entry.id === providerID);
            modelMap = new Map<string, Set<string>>();
            if (provider !== undefined) {
                for (const model of provider.models) {
                    const variantIDs = model.variants ?? [];
                    if (variantIDs.length === 0) {
                        continue;
                    }
                    modelMap.set(model.id, new Set(variantIDs.map((variant) => variant.id)));
                }
            }
            byProvider.set(providerID, modelMap);
        }
        return modelMap.get(modelID)?.has(variantID) ?? false;
    };
}
