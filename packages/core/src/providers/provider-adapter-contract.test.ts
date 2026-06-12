import { modelProviderCatalog } from '@mission-control/config';
import { describe, expect, it } from 'vitest';
import { providerAdapterContractRegistrations } from './provider-adapter-contract-registrations.js';
import {
    findExecutableProviderContractGaps,
    type ProviderAdapterContractCatalogEntry,
} from './provider-adapter-contract-test-support.js';

describe('provider adapter contract coverage', () => {
    it('covers every executable provider in the catalog', () => {
        // Given
        const catalog = modelProviderCatalog;

        // When
        const gaps = findExecutableProviderContractGaps(catalog, providerAdapterContractRegistrations);

        // Then
        expect(gaps).toEqual([]);
    });

    it('reports an executable fixture provider without contract registration', () => {
        // Given
        const catalog = [
            {
                id: 'dummy-provider',
                capability: {
                    status: 'executable',
                    adapterFamily: 'openai-compatible',
                },
            },
        ] as const satisfies readonly ProviderAdapterContractCatalogEntry[];

        // When
        const gaps = findExecutableProviderContractGaps(catalog, providerAdapterContractRegistrations);

        // Then
        expect(gaps).toEqual(['dummy-provider: missing provider adapter contract']);
    });
});
